import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { coordinatorSnapshotSchema } from "../src/coordinator";
import { createEngineClient } from "../src/engine";
import type { Engine } from "../src/jobs";
import { createLocalRuntime } from "../src/local";
import { parseProject } from "../src/project";

for (const scenario of [
  "none",
  "artifact",
  "result",
  "late-artifact",
  "disconnected",
] as const) {
  test(`PDF reaches Hono before the engine tail; ${scenario} preserves atomic publication`, async () => {
    const root = await mkdtemp(join(tmpdir(), "streaming-"));
    const path = join(root, "store.sqlite");
    const projectId = crypto.randomUUID();
    const release = Promise.withResolvers<void>();
    const pdfReady = Promise.withResolvers<void>();
    let tailArrived = false;
    const pdf = "%PDF-streamed";
    const client = createEngineClient(async (request) => {
      const project = parseProject(await request.json());
      if (project.files["main.tex"] === "baseline") {
        const form = new FormData();
        form.set(
          "pdf",
          new Blob(["%PDF-baseline"], { type: "application/pdf" }),
          "output.pdf",
        );
        form.set("log", "baseline log");
        return new Response(form);
      }
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `--build\r\nContent-Disposition: form-data; name="pdf"; filename="output.pdf"\r\nContent-Type: application/pdf\r\n\r\n${pdf}\r\n--build\r\nContent-Disposition: form-data; name="log"\r\n\r\n`,
            ),
          );
          void release.promise.then(() => {
            tailArrived = true;
            controller.enqueue(
              encoder.encode(
                'stream log\r\n--build\r\nContent-Disposition: form-data; name="artifact:main.aux"; filename="main.aux"\r\nContent-Type: application/octet-stream\r\n\r\naux\r\n--build--\r\n',
              ),
            );
            controller.close();
          });
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "multipart/form-data; boundary=build" },
      });
    });
    const engine: Engine = (project, context) =>
      client(project, {
        ...context,
        onPdf(body) {
          context.onPdf?.(body);
          if (project.files["main.tex"] === "streamed") pdfReady.resolve();
        },
      });
    const runtime = createLocalRuntime({
      path,
      engine,
      projectEngine: () => engine,
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
