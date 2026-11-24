import type { ArchiveSink, CompileSinks } from "@texfolia/contracts/compiler";

import { pdfPath } from "#/lib/builds/artifacts";
import type { Engine } from "#/lib/builds/types";

type BufferedOutput = {
  pdf: Uint8Array;
  log: string;
  timing: Awaited<ReturnType<Engine>>["timing"];
  files?: Record<string, Uint8Array>;
  cacheArchive?: Uint8Array;
  preview?: Uint8Array;
};

/** An engine that may return its artifacts instead of streaming them. */
export type TestEngine = (
  ...parameters: Parameters<Engine>
) => Promise<Awaited<ReturnType<Engine>> | BufferedOutput>;

export async function fill(
  sink: ArchiveSink | Promise<ArchiveSink>,
  content: string | Uint8Array,
) {
  const { write, close } = await sink;
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  if (bytes.byteLength) await write(bytes);
  await close?.();
}

export function streamed(engine: TestEngine): Engine {
  return async (project, context) => {
    const output = await engine(project, context);
    if (!("pdf" in output)) return output;
    const { artifacts } = context;
    const { pdf, preview, cacheArchive, log, timing } = output;
    await fill(artifacts.pdf(pdf.byteLength), pdf);
    if (preview) await fill(artifacts.preview(preview.byteLength), preview);
    for (const [path, content] of Object.entries(output.files ?? {}))
      if (path !== pdfPath(project.mainFile))
        await fill(artifacts.file(path, content.byteLength), content);
    if (cacheArchive)
      await fill(artifacts.cache(cacheArchive.byteLength), cacheArchive);
    return { sizeBytes: pdf.byteLength, log, timing };
  };
}

/** Collects what an engine streams. */
export function collectSinks() {
  const entries = new Map<string, Uint8Array>();
  const open = (name: string, size: number): ArchiveSink => {
    const bytes = new Uint8Array(size);
    let filled = 0;
    return {
      write: (part) => {
        bytes.set(part, filled);
        filled += part.byteLength;
      },
      close: () => void entries.set(name, bytes),
    };
  };
  const sinks: Required<CompileSinks> = {
    pdf: (size) => open("pdf", size),
    preview: (size) => open("preview", size),
    cache: (size) => open("cache", size),
    file: (path, size) => open(`file:${path}`, size),
  };
  return {
    sinks,
    entries,
    text: (name: string) =>
      entries.has(name)
        ? new TextDecoder().decode(entries.get(name))
        : undefined,
  };
}
