import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { HttpError, type Project } from "./project";

async function readLog(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value.subarray(0, Math.max(0, 64 * 1024 - bytes));
    chunks.push(chunk);
    bytes += chunk.length;
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function compile(
  project: Project,
  timeoutMs = 60_000,
): Promise<{ pdf: Uint8Array; log: string }> {
  const root = await mkdtemp(join(tmpdir(), "texfolia-"));
  try {
    const source = join(root, "source");
    const output = join(root, "output");
    await mkdir(output);
    for (const [path, content] of Object.entries(project.files)) {
      const target = join(source, path);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(
        target,
        typeof content === "string"
          ? content
          : Buffer.from(content.base64, "base64"),
      );
    }
    const child = Bun.spawn(
      [
        "tectonic",
        "--untrusted",
        "--keep-logs",
        "--outdir",
        output,
        project.mainFile,
      ],
      {
        cwd: source,
        // Do not pass service secrets to the TeX process.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
          TECTONIC_UNTRUSTED_MODE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    let exit: number;
    let stdout: string;
    let stderr: string;
    try {
      [exit, stdout, stderr] = await Promise.all([
        child.exited,
        readLog(child.stdout),
        readLog(child.stderr),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const outputName = basename(project.mainFile, ".tex");
    const transcript = Bun.file(join(output, outputName + ".log"));
    const limit = 64 * 1024;
    let texLog = "";
    if (await transcript.exists()) {
      texLog =
        transcript.size <= limit
          ? await transcript.text()
          : `${await transcript.slice(0, limit / 2).text()}\n…\n${await transcript.slice(-limit / 2).text()}`;
    }
    const log = [stdout, stderr, texLog].filter(Boolean).join("\n").trim();
    if (timedOut) throw new HttpError(408, "Compilation timed out", log);
    if (exit !== 0) throw new HttpError(422, "LaTeX compilation failed", log);
    const pdf = Bun.file(join(output, outputName + ".pdf"));
    if (!(await pdf.exists())) throw new Error("Tectonic produced no PDF");
    if (pdf.size > 20 * 1024 * 1024)
      throw new HttpError(413, "PDF exceeds 20 MiB");
    return { pdf: new Uint8Array(await pdf.arrayBuffer()), log };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
