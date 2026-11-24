import { engineTimingSchema } from "@texfolia/contracts";
import {
  encodeCompileRequest,
  readCompileArtifacts,
  writeArchive,
  type CompileManifest,
} from "@texfolia/contracts/compiler";

// Compiles directly on one running engine, without the Worker or its pool.
export type Files = Record<string, string | Uint8Array<ArrayBuffer>>;
export type EngineRequest = {
  files: Files;
  mainFile?: string;
  cache?: Uint8Array | null;
  clean?: boolean;
  preview?: boolean;
  incremental?: boolean;
  affinity?: string;
  timeoutMs?: number;
};

const hash = async (bytes: Uint8Array<ArrayBuffer>) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
let generation = Date.now();

export async function compileRequest(options: EngineRequest) {
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(options.files)) {
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    const digest = await hash(bytes);
    files[path] = digest;
    blobs.set(digest, bytes);
  }
  const manifest: CompileManifest = {
    mainFile: options.mainFile ?? "main.tex",
    files,
    ...(options.clean ? { clean: true } : {}),
    ...(options.preview ? { preview: true } : {}),
    ...(options.incremental ? { incremental: true } : {}),
  };
  const archive = encodeCompileRequest({
    manifest,
    blobs: options.incremental
      ? []
      : [...blobs].map(([hash, content]) => ({
          hash,
          size: content.length,
          content,
        })),
    ...(options.cache
      ? { cache: { size: options.cache.length, content: options.cache } }
      : {}),
  });
  return new Request("http://engine/compile", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-tar",
      "X-Compile-Id": crypto.randomUUID(),
      "X-Compile-Affinity": options.affinity ?? "script",
      "X-Compile-Slot": "0",
      "X-Compile-Generation": String(++generation),
      "X-Compile-Timeout-Ms": String(options.timeoutMs ?? 60_000),
    },
    body: archive.body,
  });
}

export async function compileOnEngine(
  options: EngineRequest,
  engineUrl = process.env.ENGINE_URL ?? "http://127.0.0.1:8081",
) {
  const response = await fetch(
    new URL("/compile", engineUrl),
    await compileRequest(options),
  );
  if (!response.headers.get("Content-Type")?.startsWith("application/x-tar"))
    throw new Error(
      `Engine returned ${response.status}: ${await response.text()}`,
    );
  const artifacts = await readCompileArtifacts(response.body!);
  return {
    ...artifacts,
    status: response.status,
    timing: engineTimingSchema.parse(
      JSON.parse(response.headers.get("X-Compile-Timing") ?? "null"),
    ),
  };
}

/** A successful compile, or an error carrying the TeX log. */
export async function compileSuccessfully(options: EngineRequest) {
  const output = await compileOnEngine(options);
  if (!output.pdf)
    throw new Error(`${output.result.error}\n${output.result.log}`);
  return { ...output, pdf: output.pdf };
}

/** Packs files the way the engine packs its build cache. */
export async function packCache(files: Map<string, Uint8Array>) {
  const archive = await new Response(
    writeArchive(
      [...files].map(([name, content]) => ({
        name,
        size: content.length,
        content,
      })),
    ).body,
  ).arrayBuffer();
  return Bun.zstdCompressSync(new Uint8Array(archive));
}
