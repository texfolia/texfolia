import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  encodeCompileHeaders,
  encodeCompileRequest,
  collectCompileArtifacts,
  readCompilePlacement,
} from "@texfolia/contracts/compiler";

import { createLocalCompiler, sqliteStore } from "../src/local";
import { dockerContainers } from "../src/local-containers";

// Drives the whole compiler against real Docker containers and real Tectonic.
const directory = await mkdtemp(join(tmpdir(), "texfolia-compiler-check-"));
const open = () =>
  createLocalCompiler({
    variables: { POOL_MAX_INSTANCES: "2", POOL_IDLE_MS: "5000" },
    store: sqliteStore(join(directory, "pool.sqlite")),
    containers: dockerContainers({
      socket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
      image: process.env.ENGINE_IMAGE ?? "texfolia-latex-engine:local",
      concurrency: 1,
    }),
    maintenance: false,
  });
let compiler = open();
const sha256 = async (text: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ).toString("hex");
const inContainer = (container: string, command: string) =>
  execFileSync(
    "docker",
    ["exec", `texfolia-${container}`, "sh", "-c", command],
    { encoding: "utf8" },
  ).trim();

async function send(
  affinity: string,
  files: Record<string, string>,
  options: {
    container?: string;
    changed?: string[];
    cache?: Uint8Array | null;
    clean?: boolean;
    id?: string;
  } = {},
) {
  const hashes: Record<string, string> = {};
  for (const [path, text] of Object.entries(files))
    hashes[path] = await sha256(text);
  const blobs = Object.entries(files)
    .filter(([path]) => !options.changed || options.changed.includes(path))
    .map(([path, text]) => {
      const content = new TextEncoder().encode(text);
      return { hash: hashes[path]!, size: content.length, content };
    });
  return compiler.fetch(
    new Request("http://compiler/compile", {
      method: "POST",
      headers: encodeCompileHeaders({
        id: options.id ?? crypto.randomUUID(),
        affinity,
        timeoutMs: 60_000,
        priority: 0,
        ...(options.container ? { container: options.container } : {}),
      }),
      body: encodeCompileRequest({
        manifest: {
          mainFile: "main.tex",
          files: hashes,
          ...(options.container ? { incremental: true } : {}),
          ...(options.clean ? { clean: true } : {}),
        },
        blobs,
        ...(options.cache
          ? { cache: { size: options.cache.length, content: options.cache } }
          : {}),
      }).body,
    }),
  );
}
async function compile(...parameters: Parameters<typeof send>) {
  const response = await send(...parameters);
  assert.equal(response.status, 200, await response.clone().text());
  const placement = readCompilePlacement(response.headers);
  assert(placement && response.body);
  const artifacts = await collectCompileArtifacts(response.body);
  assert(artifacts.pdf && artifacts.cache);
  assert.equal(new TextDecoder().decode(artifacts.pdf.slice(0, 5)), "%PDF-");
  assert(artifacts.files.has("main.synctex.gz"));
  const timing = JSON.parse(response.headers.get("X-Compile-Timing") ?? "null");
  return { ...artifacts, cache: artifacts.cache, placement, timing };
}
const a = (text: string) => ({
  "main.tex": String.raw`\documentclass{article}\begin{document}\tableofcontents\section{A}\input{private-a.tex}\end{document}`,
  "private-a.tex": text,
});
const b = (text: string) => ({
  "main.tex": String.raw`\documentclass{article}\begin{document}\IfFileExists{private-a.tex}{\undefinedcommand}{}${text}\end{document}`,
});

try {
  const first = await compile("a", a("Private A first."));
  assert.equal(first.placement.outcome, "cold");
  const { container } = first.placement;
  const second = await compile("a", a("Private A second."), {
    container,
    changed: ["private-a.tex"],
  });
  assert.equal(second.placement.outcome, "affinity");
  assert.equal(second.timing.archiveStatus, "warm");
  assert.equal(second.timing.cacheUsed, true);

  // Another caller takes the warm process and finds nothing of A.
  const other = await compile("b", b("Public B first."));
  assert.equal(other.placement.container, container);
  assert.equal(other.placement.outcome, "spare");
  assert.equal(other.timing.cacheUsed, false);
  const retained = inContainer(container, "cat /tmp/texfolia-slot-*/*");
  assert(retained.includes("Public B first."));
  assert(!retained.includes("Private A"), "A's sources survived B's compile");

  const lost = await send("a", a("Private A third."), {
    container,
    changed: ["private-a.tex"],
  });
  assert.equal(lost.status, 409);
  await lost.body?.cancel();
  const restored = await compile("a", a("Private A third."), {
    cache: second.cache,
  });
  assert.equal(restored.timing.archiveStatus, "restored");
  assert.equal(restored.timing.containerBootId, first.timing.containerBootId);

  // A source changed on disk is noticed and repaired by a full request.
  inContainer(
    container,
    'for file in /tmp/texfolia-slot-*/*; do chmod u+w "$file"; printf corrupted > "$file"; done',
  );
  const corrupted = await send("a", a("Private A third."), {
    container,
    changed: [],
  });
  assert.equal(corrupted.status, 409);
  await corrupted.body?.cancel();
  await compile("a", a("Private A third."));
  const clean = await compile("a", a("Private A third."), {
    container,
    changed: [],
    clean: true,
  });
  assert.equal(clean.timing.cacheUsed, false);

  // The pool survives a restart of its process.
  await compiler.close();
  compiler = open();
  const afterRestart = await compile("a", a("Private A fourth."), {
    container,
    changed: ["private-a.tex"],
  });
  assert.equal(afterRestart.placement.outcome, "affinity");

  // Concurrent callers get their own containers; more wait their turn.
  const burst = await Promise.all(
    ["b", "c", "d", "e"].map((affinity) => compile(affinity, b(affinity))),
  );
  assert.equal(
    new Set(burst.map(({ placement }) => placement.container)).size,
    2,
  );

  // Cancelling a running compile stops TeX and keeps the container usable.
  const id = crypto.randomUUID();
  const running = send(
    "loop",
    {
      "main.tex": String.raw`\documentclass{article}\begin{document}\def\x{\x}\x\end{document}`,
    },
    { id },
  );
  while (
    !(await compiler.snapshot()).containers.some((entry) =>
      entry.slots.some((slot) => slot.lease?.id === id),
    )
  )
    await Bun.sleep(5);
  await Bun.sleep(300);
  const cancelled = await compiler.fetch(
    new Request(`http://compiler/compilations/${id}`, { method: "DELETE" }),
  );
  assert.equal(cancelled.status, 204);
  assert.equal((await running).status, 409);
  await (await running).text();
  await compile("loop", b("after cancel"));

  // With nothing to do, the pool drains to zero containers.
  await Bun.sleep(5100);
  await compiler.maintain();
  const deadline = Date.now() + 30_000;
  while ((await compiler.snapshot()).containers.length) {
    assert(Date.now() < deadline, "The pool did not drain");
    await Bun.sleep(100);
  }
  console.info(
    "Verified real Tectonic: incremental reuse, isolation between callers, cache restore, on-disk repair, clean bypass, pool restart, burst queueing, cancellation, and drain to zero.",
  );
} finally {
  for (const { name } of (await compiler.snapshot()).containers)
    execFileSync("docker", ["rm", "-f", `texfolia-${name}`]);
  await compiler.close();
  await rm(directory, { recursive: true, force: true });
}
