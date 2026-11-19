import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { coordinatorSnapshotSchema } from "../src/coordinator";
import { createEngineClient } from "../src/engine";
import { createLocalRuntime } from "../src/local";
import {
  sourceDeltaSchema,
  sourceHash,
  type SourceDelta,
} from "../src/source-sync";

const directory = await mkdtemp(join(tmpdir(), "texfolia-delta-check-"));
const container = `texfolia-delta-check-${crypto.randomUUID()}`;
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
let runtime: ReturnType<typeof createLocalRuntime> | undefined;
const projectId = crypto.randomUUID();
const requests: SourceDelta[] = [];
const ready = async (url: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fetch(`${url}/health`).catch(() => null))?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("Engine did not become ready");
};
try {
  docker(
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    "-p",
    "127.0.0.1::8080",
    process.env.ENGINE_IMAGE ?? "texfolia-latex-engine:local",
  );
  let url = `http://${docker("port", container, "8080")}`;
  await ready(url);
  const engine = createEngineClient(async (request) => {
    if (request.method === "POST")
      requests.push(sourceDeltaSchema.parse(await request.clone().json()));
    return fetch(
      new Request(new URL(new URL(request.url).pathname, url).href, request),
    );
  }, url);
  runtime = createLocalRuntime({
    path: join(directory, "state.sqlite"),
    projectEngine: () => engine,
  });
  const text = async (content: string) => ({
    hash: await sourceHash(new TextEncoder().encode(content)),
    content,
  });
  const sources = {
    "main.tex": await text(
      String.raw`\documentclass{article}\begin{document}\input{sections/section.tex}\IfFileExists{assets/data.bin}{Asset present}{\undefinedcommand}\end{document}`,
    ),
    "sections/section.tex": await text("First revision."),
    "assets/data.bin": {
      hash: await sourceHash(new Uint8Array([0, 1, 255])),
      content: { base64: "AAH/" },
    },
  };
  const compile = async (delta: SourceDelta) => {
    assert(runtime);
    const id = crypto.randomUUID();
    const response = await runtime.fetch(
      new Request(`http://local/projects/${projectId}/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Compilation-Id": id },
        body: JSON.stringify(delta),
      }),
    );
    assert.equal(response.status, 202, await response.clone().text());
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const state = coordinatorSnapshotSchema.parse(
        await (
          await runtime.fetch(new Request(`http://local/projects/${projectId}`))
        ).json(),
      );
      if (state.current?.id === id && state.current.status === "failed")
        throw new Error(`${state.current.error}\n${state.current.log}`);
      if (state.current?.id === id && state.current.status === "succeeded") {
        const pdf = await runtime.fetch(
          new Request(
            `http://local/projects/${projectId}/compilations/${id}.pdf`,
          ),
        );
        assert.equal(pdf.status, 200);
        assert((await pdf.text()).startsWith("%PDF-"));
        return;
      }
      await Bun.sleep(20);
    }
    throw new Error("Compilation stuck without a terminal result");
  };
  await compile({
    mainFile: "main.tex",
    baseRevision: 0,
    revision: 1,
    files: sources,
    deleted: [],
    resync: true,
  });
  await compile({
    mainFile: "main.tex",
    baseRevision: 1,
    revision: 2,
    files: { "sections/section.tex": await text("Only this file changed.") },
    deleted: [],
  });
  assert.deepEqual(Object.keys(requests[1]!.files), ["sections/section.tex"]);
  assert.equal(requests[1]!.resync, undefined);
  docker("restart", container);
  url = `http://${docker("port", container, "8080")}`;
  await ready(url);
  const beforeRestart = requests.length;
  await compile({
    mainFile: "main.tex",
    baseRevision: 2,
    revision: 3,
    files: {},
    deleted: [],
  });
  assert.equal(requests.length - beforeRestart, 2);
  assert.equal(requests.at(-1)!.resync, true);
  assert.equal(Object.keys(requests.at(-1)!.files).length, 3);
  docker(
    "exec",
    container,
    "sh",
    "-c",
    'for directory in /tmp/texfolia-sources-*; do test -f "$directory/main.tex" || continue; chmod u+w "$directory/main.tex"; printf corrupted > "$directory/main.tex"; done',
  );
  const beforeMismatch = requests.length;
  await compile({
    mainFile: "main.tex",
    baseRevision: 3,
    revision: 4,
    files: {},
    deleted: [],
  });
  assert.equal(requests.length - beforeMismatch, 2);
  assert.equal(requests.at(-1)!.resync, true);
  console.info(
    "Verified real Tectonic PDFs, changed-file-only recompiles, unchanged binary reuse, restart resync, and on-disk hash repair.",
  );
} finally {
  await runtime?.close();
  try {
    docker("rm", "-f", container);
  } catch {}
  await rm(directory, { recursive: true, force: true });
}
