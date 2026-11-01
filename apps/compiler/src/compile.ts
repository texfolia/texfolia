import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

export class HttpError extends Error {
  constructor(public status: number, message: string, public log?: string) {
    super(message);
  }
}

export type Project = { mainFile: string; files: Record<string, string | { base64: string }> };

function safePath(value: string): boolean {
  return value.length > 0 && value.length <= 240 && !/[\\:\x00-\x1f]/.test(value) &&
    !value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function parseProject(value: unknown): Project {
  if (!value || typeof value !== "object") throw new HttpError(400, "Expected a project object");
  const { mainFile = "main.tex", files } = value as Project;
  if (typeof mainFile !== "string" || !safePath(mainFile) || !mainFile.endsWith(".tex")) {
    throw new HttpError(400, "mainFile must be a relative .tex path");
  }
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new HttpError(400, "files must be an object");
  const entries = Object.entries(files);
  if (!entries.length || entries.length > 200) throw new HttpError(400, "Provide 1–200 files");
  if (!Object.hasOwn(files, mainFile)) throw new HttpError(400, "mainFile is missing from files");
  for (const [path, content] of entries) {
    if (!safePath(path)) throw new HttpError(400, `Invalid file path: ${path}`);
    if (typeof content !== "string" && !(content && typeof content === "object" &&
      typeof content.base64 === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content.base64))) {
      throw new HttpError(400, `Invalid content for ${path}`);
    }
    // Avoid ambiguous file/directory collisions before writing anything.
    if (entries.some(([other]) => other.startsWith(`${path}/`))) throw new HttpError(400, "File paths overlap");
  }
  return { mainFile, files };
}

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

export async function compile(project: Project, timeoutMs = 60_000): Promise<{ pdf: Uint8Array; log: string }> {
  const root = await mkdtemp(join(tmpdir(), "texfolia-"));
  try {
    const source = join(root, "source");
    const output = join(root, "output");
    await mkdir(output);
    for (const [path, content] of Object.entries(project.files)) {
      const target = join(source, path);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, typeof content === "string" ? content : Buffer.from(content.base64, "base64"));
    }
    const child = Bun.spawn([
      "tectonic", "--untrusted", "--keep-logs", "--outdir", output, project.mainFile,
    ], {
      cwd: source,
      // Do not pass service secrets to the TeX process.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        TECTONIC_UNTRUSTED_MODE: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    let exit: number;
    let stdout: string;
    let stderr: string;
    try {
      [exit, stdout, stderr] = await Promise.all([child.exited, readLog(child.stdout), readLog(child.stderr)]);
    } finally { clearTimeout(timer); }
    const log = `${stdout}\n${stderr}`.trim();
    if (timedOut) throw new HttpError(408, "Compilation timed out", log);
    if (exit !== 0) throw new HttpError(422, "LaTeX compilation failed", log);
    const pdf = Bun.file(join(output, basename(project.mainFile, ".tex") + ".pdf"));
    if (!await pdf.exists()) throw new Error("Tectonic produced no PDF");
    if (pdf.size > 20 * 1024 * 1024) throw new HttpError(413, "PDF exceeds 20 MiB");
    return { pdf: new Uint8Array(await pdf.arrayBuffer()), log };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
