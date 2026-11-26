import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import {
  buildSnapshotSchema,
  compileJobSchema,
  type CompileJob,
} from "@texfolia/contracts";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

import { hashSource } from "#/lib/compile";

import { createLocalCompiler } from "../../compiler/src/local";
import { dockerLayer } from "../../compiler/src/local-containers";
import { PoolStore } from "../../compiler/src/pool";
import { buildsBindings } from "./builds/miniflare";

// Real build coordinators in workerd, the real compiler, Docker, and Tectonic.
// Needs Docker and the engine image; it is not part of CI.
const directory = await mkdtemp(join(tmpdir(), "texfolia-compile-engine-"));
const compiler = createLocalCompiler({
  variables: { POOL_MAX_INSTANCES: "2" },
  store: PoolStore.memory,
  containers: dockerLayer({
    socket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    image: process.env.ENGINE_IMAGE ?? "texfolia-latex-engine:local",
    concurrency: 1,
  }),
  maintenance: false,
});
const worker = await build({
  stdin: {
    contents: `
      import { buildsFetcher, handleBuildQueue } from "#/lib/builds/server";
      export { CompileUsage, ProjectBuilds } from "#/lib/builds/server";
      export default {
        queue: handleBuildQueue,
        fetch: (request, env) => buildsFetcher(env.BUILDS).fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
        }),
      };`,
    resolveDir: new URL("../", import.meta.url).pathname,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd"],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire("file:///worker.js");',
  },
  external: [
    ...builtinModules,
    "node:*",
    "cloudflare:workers",
    "cloudflare:sockets",
  ],
  define: { "import.meta.env.DEV": "false" },
});
const script = worker.outputFiles[0]?.text;
assert(script);
let compileRequests = 0;
const bytesSent: number[] = [];
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    name: "compile-engine-test",
    modules: true,
    script,
    compatibilityDate: "2026-10-31",
    compatibilityFlags: ["nodejs_compat"],
    ...buildsBindings,
    serviceBindings: {
      COMPILER: async (request) => {
        const body =
          request.method === "POST" ? await request.arrayBuffer() : undefined;
        if (body) {
          compileRequests++;
          bytesSent.push(body.byteLength);
        }
        return compiler.fetch(
          new Request(request.url, {
            method: request.method,
            headers: [...request.headers.entries()],
            body,
          }),
        );
      },
    },
  }),
  resourcePersistencePath: directory,
});
const projectId = crypto.randomUUID();
const origin = (await mf.ready).origin;
const request = (path: string, init?: RequestInit) =>
  fetch(`${origin}/projects/${projectId}${path}`, init);
const encoder = new TextEncoder();
const text = async (content: string) => ({
  hash: await hashSource(encoder.encode(content)),
  content,
});
const document = (body: string) =>
  String.raw`\documentclass{article}\usepackage{graphicx}\begin{document}\tableofcontents\section{One}\label{one}${body} See~\ref{one}.\includegraphics[width=1cm]{image.png}\end{document}`;
// A valid one-pixel PNG; xdvipdfmx rejects a wrong checksum.
const image = (() => {
  const chunk = (name: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
      chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
})();
async function submit(body: object, headers: Record<string, string> = {}) {
  const id = crypto.randomUUID();
  const response = await request("/compile", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Compilation-Id": id,
      "X-Compile-Plan": "pro",
      "X-Compile-User": "engine-test",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 202, await response.text());
  return id;
}
async function settled(id: string): Promise<CompileJob> {
  const deadline = Date.now() + 60_000;
  while (true) {
    const job = compileJobSchema.parse(
      await (await request(`/jobs/${id}`)).json(),
    );
    if (job.status === "succeeded" || job.status === "failed") return job;
    assert(Date.now() < deadline, "The compile never settled");
    await Bun.sleep(25);
  }
}
try {
  const bucket = await mf.getR2Bucket("SOURCES");
  const imageHash = await hashSource(image);
  await bucket.put(`projects/${projectId}/sources/${imageHash}`, image);

  // Completion is pushed: one socket reports every transition.
  const events: string[] = [];
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}/projects/${projectId}/events`,
  );
  socket.onmessage = ({ data }) => {
    const parsed = buildSnapshotSchema.safeParse(JSON.parse(String(data)));
    if (parsed.success && parsed.data.current)
      events.push(parsed.data.current.status);
  };
  await new Promise((resolve) => {
    socket.onopen = resolve;
  });

  const first = await submit({
    mainFile: "main.tex",
    baseRevision: 0,
    revision: 1,
    resync: true,
    files: {
      "main.tex": await text(document("First.")),
      "image.png": { hash: imageHash },
    },
    deleted: [],
  });
  const preview = await request(`/jobs/${first}/pdf`);
  if (preview.status !== 200) assert.fail(JSON.stringify(await settled(first)));
  assert.equal(preview.headers.get("Content-Type"), "application/pdf");
  const streamed = new Uint8Array(await preview.arrayBuffer());
  assert.equal(new TextDecoder().decode(streamed.slice(0, 5)), "%PDF-");
  const firstJob = await settled(first);
  assert.equal(firstJob.status, "succeeded", JSON.stringify(firstJob));
  assert.deepEqual(
    new Uint8Array(
      await (await request(`/compilations/${first}.pdf`)).arrayBuffer(),
    ),
    streamed,
  );
  assert((await request("/build/files?path=main.synctex.gz")).ok);
  for (const status of ["queued", "running", "succeeded"])
    assert(events.includes(status), `The socket never reported ${status}`);

  // An edit sends one file to the same warm container.
  const second = await submit({
    mainFile: "main.tex",
    baseRevision: 1,
    revision: 2,
    files: { "main.tex": await text(document("Second.")) },
    deleted: [],
  });
  const secondJob = await settled(second);
  assert.equal(secondJob.status, "succeeded", JSON.stringify(secondJob));
  assert.equal(secondJob.timing?.archiveStatus, "warm");
  assert.equal(secondJob.timing?.cacheUsed, true);
  assert(
    (bytesSent[1] ?? Infinity) < (bytesSent[0] ?? 0),
    "An incremental compile must send less than a full one",
  );

  // A TeX failure is terminal, keeps the last PDF, and exposes its log.
  const failed = await submit({
    mainFile: "main.tex",
    baseRevision: 2,
    revision: 3,
    files: { "main.tex": await text(String.raw`\undefinedcommand`) },
    deleted: [],
  });
  const failedJob = await settled(failed);
  assert.equal(failedJob.status, "failed");
  assert(failedJob.log.includes("undefinedcommand"));
  assert((await request("/build/files?path=main.pdf")).ok);

  // A newer revision stops the TeX run it replaces.
  const endless = await submit({
    mainFile: "main.tex",
    baseRevision: 3,
    revision: 4,
    files: {
      "main.tex": await text(
        String.raw`\documentclass{article}\begin{document}\def\x{\x}\x\end{document}`,
      ),
    },
    deleted: [],
  });
  while (
    !(await compiler.snapshot()).containers.some((container) =>
      container.slots.some((slot) => slot.lease),
    )
  )
    await Bun.sleep(10);
  const replaced = performance.now();
  const last = await submit({
    mainFile: "main.tex",
    baseRevision: 4,
    revision: 5,
    files: { "main.tex": await text(document("Last.")) },
    deleted: [],
  });
  const lastJob = await settled(last);
  assert.equal(lastJob.status, "succeeded", JSON.stringify(lastJob));
  assert.equal((await settled(endless)).status, "failed");
  assert(performance.now() - replaced < 20_000, "Cancellation took too long");

  // A lost container costs one resync, and the build cache survives in storage.
  for (const { name } of (await compiler.snapshot()).containers)
    Bun.spawnSync(["docker", "restart", "-t", "0", `texfolia-${name}`]);
  const before = compileRequests;
  const recovered = await submit({
    mainFile: "main.tex",
    baseRevision: 5,
    revision: 6,
    files: { "main.tex": await text(document("Recovered.")) },
    deleted: [],
  });
  const recoveredJob = await settled(recovered);
  assert.equal(recoveredJob.status, "succeeded", JSON.stringify(recoveredJob));
  assert(compileRequests - before >= 2);
  socket.close();
  console.info(
    `Compile engine passed with real Tectonic: streamed PDF, artifacts, pushed completion, incremental edit (${bytesSent[0]} → ${bytesSent[1]} bytes), TeX failure, supersede and cancel, and container loss.`,
  );
} finally {
  await mf.dispose();
  for (const { name } of (await compiler.snapshot()).containers)
    Bun.spawnSync(["docker", "rm", "-f", `texfolia-${name}`]);
  await compiler.close();
  await rm(directory, { recursive: true, force: true });
}
