import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { coordinatorSnapshotSchema } from "../src/coordinator";
import { createLocalRuntime } from "../src/local";
import { localProjectEngine } from "../src/local-containers";
import { sourceHash } from "../src/source-sync";

const directory = process.env.RESULT_DIR ?? "/private/tmp/nat239-cold-starts";
const image = process.env.ENGINE_IMAGE ?? "texfolia-latex-engine:nat239";
const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const projectId = crypto.randomUUID();
const container = `texfolia-project-${projectId}`;
const fixture = String.raw`\documentclass{article}
\begin{document}
\tableofcontents
\section{Start}\label{sec:start}
Cold start verification. See Section~\ref{sec:end}.
${Array.from({ length: 25 }, (_, index) => `\\section{Section ${index}} See Section~\\ref{sec:start}.\\par`).join("\n")}
\section{End}\label{sec:end}
\end{document}`;
const hash = await sourceHash(new TextEncoder().encode(fixture));
await mkdir(directory, { recursive: true });

async function docker(args: string[]) {
  const command = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

let revision = 0;
async function sample(
  mode: "compile-triggered" | "editor-prewarmed",
  pair: number,
) {
  const reads: string[] = [];
  let prewarm: Promise<void> | undefined;
  const runtime = createLocalRuntime({
    path: join(directory, "compiler.sqlite"),
    projectEngine: (id, store) => {
      const read = store.read;
      store.read = async (key) => {
        reads.push(key);
        return read(key);
      };
      const engine = localProjectEngine(id, {
        socket,
        image,
        store,
      });
      const start = engine.prewarm;
      engine.prewarm = () => {
        prewarm = mode === "editor-prewarmed" ? start?.() : Promise.resolve();
        return prewarm ?? Promise.resolve();
      };
      return engine;
    },
  });
  const request = (path: string, init?: RequestInit) =>
    runtime.fetch(
      new Request(`http://local/projects/${projectId}${path}`, init),
    );
  const opened = performance.now();
  const events = await request("/events", {
    signal: AbortSignal.timeout(120_000),
  });
  const reader = events.body!.getReader();
  try {
    await prewarm;
    const editorPrepareMs = performance.now() - opened;
    const cpuUsage = async () => {
      const counters = await docker([
        "exec",
        container,
        "cat",
        "/sys/fs/cgroup/cpu.stat",
        "/sys/fs/cgroup/cpu.max",
      ]);
      const usage = counters.match(/^usage_usec (\d+)$/m);
      if (!usage?.[1]) throw new Error("Missing container CPU counter");
      return { usageMicros: Number(usage[1]), counters };
    };
    const cpuBefore =
      mode === "editor-prewarmed" ? await cpuUsage() : undefined;
    const jobId = crypto.randomUUID();
    const started = performance.now();
    const submitted = await request("/compile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Compilation-Id": jobId,
      },
      body: JSON.stringify({
        mainFile: "main.tex",
        baseRevision: revision,
        revision: ++revision,
        resync: true,
        deleted: [],
        files: { "main.tex": { hash, content: fixture } },
      }),
    });
    if (submitted.status !== 202)
      throw new Error(
        `Submission failed: ${submitted.status} ${await submitted.text()}`,
      );
    const pdf = (async () => {
      const response = await request(`/jobs/${jobId}/pdf`);
      if (!response.ok) throw new Error(`Preview failed: ${response.status}`);
      const pdfReader = response.body!.getReader();
      const first = await pdfReader.read();
      const firstPdfMs = performance.now() - started;
      const parts: Uint8Array<ArrayBuffer>[] = first.value
        ? [new Uint8Array(first.value)]
        : [];
      while (true) {
        const chunk = await pdfReader.read();
        if (chunk.done) break;
        parts.push(new Uint8Array(chunk.value));
      }
      const blob = new Blob(parts);
      if (
        blob.size < 1000 ||
        !(await blob.slice(0, 5).text()).startsWith("%PDF-")
      )
        throw new Error("Invalid PDF");
      await writeFile(
        join(directory, `${pair}-${mode}.pdf`),
        new Uint8Array(await blob.arrayBuffer()),
      );
      return { firstPdfMs, pdfBytes: blob.size };
    })();
    void pdf.catch(() => {});
    let buffered = "";
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before compilation completed");
      buffered += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) !== -1) {
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (!frame.startsWith("data: ")) continue;
        const snapshot = coordinatorSnapshotSchema.parse(
          JSON.parse(frame.slice(6)),
        );
        if (
          snapshot.current?.id !== jobId ||
          !["succeeded", "failed"].includes(snapshot.current.status)
        )
          continue;
        const compileToSavedMs = performance.now() - started;
        if (snapshot.current.status !== "succeeded")
          throw new Error(JSON.stringify(snapshot.current));
        const timing = snapshot.current.timing;
        if (
          !timing ||
          timing.archiveStatus !== (pair < 0 ? "missing" : "restored")
        )
          throw new Error(`Restore did not happen: ${JSON.stringify(timing)}`);
        if (
          reads.filter((key) => key.endsWith("cache.tar.zst")).length !== 1 ||
          reads.some((key) => key.includes("/builds/"))
        )
          throw new Error(`Wrong cache fetches: ${reads}`);
        if (pair >= 0 && !timing.cacheUsed)
          throw new Error("Restored cache was not used");
        const cpuAfter = cpuBefore ? await cpuUsage() : undefined;
        return {
          pair,
          mode,
          editorPrepareMs,
          compileToSavedMs,
          ...(await pdf),
          timing,
          reads,
          texReruns: (snapshot.current.log.match(/Rerunning TeX/g) ?? [])
            .length,
          cpuMs:
            cpuBefore && cpuAfter
              ? (cpuAfter.usageMicros - cpuBefore.usageMicros) / 1000
              : null,
          cpuCounters: cpuAfter?.counters,
        };
      }
    }
  } finally {
    await reader.cancel();
    await runtime.close();
    await docker(["rm", "-f", container]);
  }
}

const imageInfo = z
  .object({
    Id: z.string(),
    Size: z.number(),
    Architecture: z.string(),
    Os: z.string(),
  })
  .parse(
    JSON.parse(
      await docker(["image", "inspect", image, "--format", "{{json .}}"]),
    ),
  );
const samples = [];
let errors = 0;
try {
  await sample("compile-triggered", -1);
  for (let pair = 0; pair < Number(process.env.PAIRS ?? 5); pair++) {
    for (const mode of ["compile-triggered", "editor-prewarmed"] as const) {
      const result = await sample(mode, pair);
      samples.push(result);
      console.info(JSON.stringify(result));
    }
  }
} catch (error) {
  errors++;
  throw error;
} finally {
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify({ fixture, image: imageInfo, errors, samples }, null, 2),
  );
}
