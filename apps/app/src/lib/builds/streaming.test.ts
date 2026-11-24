import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCompilerFixture,
  fixtureResponse,
} from "../../../test/builds/compiler-fixture";
import { createBuildsRuntime } from "../../../test/builds/runtime";
import { sourceText } from "../../../test/builds/stores";
import { createCompilerEngine } from "./compiler";
import { cacheKey, coordinatorSnapshotSchema } from "./coordinator";
import type { Engine } from "./types";

for (const scenario of [
  "none",
  "artifact",
  "result",
  "late-artifact",
  "disconnected",
] as const) {
  test(`PDF reaches its viewer before the engine tail; ${scenario} preserves atomic publication`, async () => {
    const root = await mkdtemp(join(tmpdir(), "streaming-"));
    const path = join(root, "store.sqlite");
    const projectId = crypto.randomUUID();
    const release = Promise.withResolvers<void>();
    const pdfReady = Promise.withResolvers<void>();
    let tailArrived = false;
    const pdf = "%PDF-streamed";
    const compiler = createCompilerFixture(async ({ manifest, sources }) => {
      const text = new TextDecoder().decode(sources["main.tex"]);
      if (text === "baseline")
        return {
          pdf: "%PDF-baseline",
          log: "baseline log",
          files: { "main.aux": "aux" },
        };
      const response = fixtureResponse(manifest, {
        pdf,
        log: "stream log",
        files: { "main.aux": "aux" },
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      // The PDF entry: its header block and one padded content block.
      const split = 1024;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, split));
            void release.promise.then(() => {
              tailArrived = true;
              controller.enqueue(bytes.slice(split));
              controller.close();
            });
          },
        }),
        { headers: response.headers },
      );
    });
    const runtime = createBuildsRuntime({
      path,
      projectEngine: (owner, store) => {
        const client = createCompilerEngine({
          projectId: owner,
          store,
          cacheKey: cacheKey(owner),
          fetch: compiler.fetch,
        });
        const engine: Engine = (project, context) =>
          client(project, {
            ...context,
            artifacts: {
              ...context.artifacts,
              async pdf(size) {
                const sink = await context.artifacts.pdf(size);
                void sourceText(project, context).then((text) => {
                  if (text === "streamed") pdfReady.resolve();
                });
                return sink;
              },
            },
          });
        return engine;
      },
    });
    const request = (suffix: string, init?: RequestInit) =>
      runtime.fetch(
        new Request(`http://local/projects/${projectId}${suffix}`, init),
      );
    const snapshot = async () =>
      coordinatorSnapshotSchema.parse(await (await request("")).json());
    const submit = async (text: string) => {
      const id = crypto.randomUUID();
      const response = await request("/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Compilation-Id": id },
        body: JSON.stringify({
          mainFile: "main.tex",
          files: { "main.tex": text },
        }),
      });
      expect(response.status).toBe(202);
      return id;
    };
    const terminal = async () => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const state = await snapshot();
        if (
          state.current?.status === "succeeded" ||
          state.current?.status === "failed"
        )
          return state;
        await Bun.sleep(10);
      }
      throw new Error("Compile did not finish");
    };
    const db = new Database(path);
    try {
      await submit("baseline");
      const baseline = await terminal();
      const id = await submit("streamed");
      const saveFails =
        scenario === "artifact" ||
        scenario === "late-artifact" ||
        scenario === "result";
      if (saveFails) {
        const pattern =
          scenario === "result"
            ? `projects/*/results/${id}.json`
            : "projects/*/builds/*/main.aux";
        db.exec(
          `CREATE TRIGGER fail_save BEFORE INSERT ON objects WHEN NEW.key GLOB '${pattern}' BEGIN SELECT RAISE(FAIL, 'injected save failure'); END`,
        );
      }
      if (scenario === "late-artifact") await pdfReady.promise;
      const preview = await request(`/jobs/${id}/pdf`);
      expect(preview.status).toBe(200);
      expect(preview.headers.get("Content-Type")).toBe("application/pdf");
      if (scenario === "disconnected") await preview.body!.cancel();
      else expect(await preview.text()).toBe(pdf);
      expect(tailArrived).toBe(false);
      const before = await snapshot();
      expect(before.current?.status).toBe("running");
      expect(before.artifacts).toEqual(baseline.artifacts);
      expect(before.latestBuild).toEqual(baseline.latestBuild);
      expect((await request(`/compilations/${id}.pdf`)).status).toBe(404);
      release.resolve();
      const after = await terminal();
      expect(after.current?.timing?.firstPdfByteMs).toBeNumber();
      expect(after.current!.timing!.firstPdfByteMs!).toBeLessThan(
        after.current!.timing!.engineRequestMs,
      );
      const { startedAt, firstPdfAt, engineFinishedAt, publishedAt } =
        after.current!.timing!;
      const instants = [startedAt, firstPdfAt, engineFinishedAt, publishedAt];
      expect(instants.every((value) => typeof value === "string")).toBe(true);
      const times = instants.map((value) => Date.parse(value!));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      if (!saveFails) {
        expect(after.current?.status).toBe("succeeded");
        expect(after.latestBuild?.id).toBe(id);
        expect(after.artifacts?.id).toBe(id);
        expect(after.artifacts?.files.map((file) => file.path).sort()).toEqual([
          "main.aux",
          "main.log",
          "main.pdf",
        ]);
      } else {
        expect(after.current).toMatchObject({
          status: "failed",
          error: "PDF compiled but could not be saved. Recompile to try again.",
        });
        expect(after.latestBuild).toEqual(baseline.latestBuild);
        expect(after.artifacts).toEqual(baseline.artifacts);
        expect((await request(`/compilations/${id}.pdf`)).status).toBe(404);
        expect(await (await request("/build/files?path=main.pdf")).text()).toBe(
          "%PDF-baseline",
        );
      }
    } finally {
      release.resolve();
      await runtime.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
