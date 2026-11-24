// The compile wire: sources and options in, artifacts out. The compiler Worker
// and its callers share these schemas; the Go engine implements the same
// archive layout.
//
// Request: `manifest.json`, then `blobs/<sha256>` for each source the container
// may lack, then an optional `cache.tar.zst`. Response: `output.pdf` first, then
// `result.json`, an optional `preview.png`, `artifacts/<index>`, and the next
// `cache.tar.zst`. A failed compile answers 408, 413 or 422 with `result.json`
// and its log. Any other failure is a JSON `CompileRejection`.
import { Schema } from "effect";

import {
  collectEntry,
  readArchive,
  writeArchive,
  type ArchiveEntry,
  type ArchiveSink,
} from "./archive";
import { maxPdfBytes } from "./builds";

export const maxCompileTimeoutMs = 300_000;
export const maxSourceBytes = 10 * 1024 * 1024;
export const maxCacheArchiveBytes = 33 * 1024 * 1024;
export const maxPreviewBytes = 4 * 1024 * 1024;
export const compileArchiveType = "application/x-tar";
// The PDF, 32 MiB of artifacts, the cache archive, and archive overhead.
const maxResponseBytes = 96 * 1024 * 1024;
// The bounded log and up to 1,024 artifact paths.
const maxResultBytes = 4 * 1024 * 1024;

export const compileHeaders = {
  id: "X-Compile-Id",
  affinity: "X-Compile-Affinity",
  timeoutMs: "X-Compile-Timeout-Ms",
  priority: "X-Compile-Priority",
  container: "X-Compile-Container",
  placement: "X-Compile-Placement",
  timing: "X-Compile-Timing",
} as const;

const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
);
const Token = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:._-]{1,128}$/));
const SourceHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/** Everything the compiler needs besides the archive, carried in headers. */
export const CompileOptions = Schema.Struct({
  id: Uuid,
  /** Opaque. Compiles with one key may reuse a container's retained sources. */
  affinity: Token,
  timeoutMs: Schema.FiniteFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: maxCompileTimeoutMs }),
  ),
  /** Only orders waiting compiles; higher goes first. */
  priority: Schema.FiniteFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 9 }),
  ),
  /**
   * Set for an incremental request: the container that ran this affinity's last
   * compile. The compiler answers `resync` when it is no longer available.
   */
  container: Schema.optionalKey(Token),
});
export type CompileOptions = typeof CompileOptions.Type;

export const CompileManifest = Schema.Struct({
  mainFile: Schema.String,
  files: Schema.Record(Schema.String, SourceHash),
  clean: Schema.optionalKey(Schema.Boolean),
  preview: Schema.optionalKey(Schema.Boolean),
  incremental: Schema.optionalKey(Schema.Boolean),
});
export type CompileManifest = typeof CompileManifest.Type;

export const CompileResult = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  log: Schema.String,
  pdf: Schema.optionalKey(Schema.String),
  files: Schema.Array(Schema.String),
});
export type CompileResult = typeof CompileResult.Type;

export const CompileRejection = Schema.Struct({
  error: Schema.String,
  code: Schema.Literals([
    "invalid",
    "resync",
    "cancelled",
    "lease",
    "busy",
    "saturated",
    "unavailable",
    "internal",
  ]),
  missing: Schema.optionalKey(Schema.Array(SourceHash)),
});
export type CompileRejection = typeof CompileRejection.Type;

/** Where a compile ran. */
export const CompilePlacement = Schema.Struct({
  container: Token,
  /** `affinity` and `spare` found a warm container; `cold` waited for one. */
  outcome: Schema.Literals(["affinity", "spare", "cold"]),
  waitMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CompilePlacement = typeof CompilePlacement.Type;

const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(CompileResult),
);
const decodeRejection = Schema.decodeUnknownOption(CompileRejection);
const decodePlacement = Schema.decodeUnknownOption(
  Schema.fromJsonString(CompilePlacement),
);
const encodeManifest = Schema.encodeSync(
  Schema.fromJsonString(CompileManifest),
);

export function encodeCompileHeaders(options: CompileOptions) {
  return {
    "Content-Type": compileArchiveType,
    [compileHeaders.id]: options.id,
    [compileHeaders.affinity]: options.affinity,
    [compileHeaders.timeoutMs]: String(options.timeoutMs),
    [compileHeaders.priority]: String(options.priority),
    ...(options.container
      ? { [compileHeaders.container]: options.container }
      : {}),
  };
}

/** The undecoded form of `CompileOptions`. */
export function compileOptionHeaders(headers: Headers) {
  const container = headers.get(compileHeaders.container);
  return {
    id: headers.get(compileHeaders.id),
    affinity: headers.get(compileHeaders.affinity),
    timeoutMs: headers.get(compileHeaders.timeoutMs),
    priority: headers.get(compileHeaders.priority) ?? "0",
    ...(container === null ? {} : { container }),
  };
}

export function encodeCompileRequest(request: {
  manifest: CompileManifest;
  blobs: readonly {
    hash: string;
    size: number;
    content: ArchiveEntry["content"];
  }[];
  cache?: { size: number; content: ArchiveEntry["content"] };
}) {
  const manifest = new TextEncoder().encode(encodeManifest(request.manifest));
  return writeArchive([
    { name: "manifest.json", size: manifest.byteLength, content: manifest },
    ...request.blobs.map(({ hash, size, content }) => ({
      name: `blobs/${hash}`,
      size,
      content,
    })),
    ...(request.cache ? [{ name: "cache.tar.zst", ...request.cache }] : []),
  ]);
}

export function readCompilePlacement(headers: Headers) {
  const placement = decodePlacement(headers.get(compileHeaders.placement));
  return placement._tag === "Some" ? placement.value : null;
}

export async function readCompileRejection(
  response: Response,
): Promise<CompileRejection | null> {
  const rejection = decodeRejection(await response.json().catch(() => null));
  return rejection._tag === "Some" ? rejection.value : null;
}

type OpenSink = (size: number) => ArchiveSink | Promise<ArchiveSink>;
/** Where each part of a compile response goes. A missing sink discards it. */
export type CompileSinks = {
  pdf?: OpenSink;
  preview?: OpenSink;
  cache?: OpenSink;
  file?: (path: string, size: number) => ArchiveSink | Promise<ArchiveSink>;
};

const discard: ArchiveSink = { write: () => {} };

/**
 * Streams a compile response into `sinks` in the order the compiler sends it:
 * the PDF, then the artifacts, then the cache. Only `result.json` is held.
 */
export async function readCompileArtifacts(
  body: ReadableStream<Uint8Array>,
  sinks: CompileSinks,
): Promise<CompileResult> {
  let first = true;
  let pdf = false;
  let result: CompileResult | undefined;
  const missing = new Set<string>();
  await readArchive(body, {
    maxBytes: maxResponseBytes,
    open: async ({ name, size }) => {
      const leading = first;
      first = false;
      switch (name) {
        case "output.pdf":
          if (!leading) throw new Error("The compiler must send the PDF first");
          if (!size) throw new Error("The compiler returned an empty PDF");
          if (size > maxPdfBytes) throw new Error("The PDF exceeds 20 MiB");
          pdf = true;
          return (await sinks.pdf?.(size)) ?? discard;
        case "result.json":
          if (size > maxResultBytes)
            throw new Error("The compiler result exceeds its limit");
          return collectEntry(size, (bytes) => {
            result = decodeResult(new TextDecoder().decode(bytes));
            for (const index of result.files.keys())
              missing.add(`artifacts/${index}`);
          });
        case "preview.png":
          return (await sinks.preview?.(size)) ?? discard;
        case "cache.tar.zst":
          return (await sinks.cache?.(size)) ?? discard;
      }
      if (!missing.delete(name)) return discard;
      const path = result?.files[Number(name.slice("artifacts/".length))];
      if (path === undefined) return discard;
      return (await sinks.file?.(path, size)) ?? discard;
    },
  });
  if (!result) throw new Error("The compiler returned no result");
  if (missing.size) throw new Error("The compiler omitted an artifact");
  if (pdf !== (result.pdf !== undefined))
    throw new Error("The compiler result does not match its PDF");
  return result;
}

/** Holds a whole compile response in memory. For tests and scripts. */
export async function collectCompileArtifacts(
  body: ReadableStream<Uint8Array>,
) {
  type Bytes = Uint8Array<ArrayBuffer>;
  let pdf: Bytes | null = null;
  let preview: Bytes | null = null;
  let cache: Bytes | null = null;
  const files = new Map<string, Bytes>();
  const result = await readCompileArtifacts(body, {
    pdf: (size) => collectEntry(size, (bytes) => void (pdf = bytes)),
    preview: (size) => collectEntry(size, (bytes) => void (preview = bytes)),
    cache: (size) => collectEntry(size, (bytes) => void (cache = bytes)),
    file: (path, size) =>
      collectEntry(size, (bytes) => void files.set(path, bytes)),
  });
  return {
    result,
    files,
    pdf: pdf as Bytes | null,
    preview: preview as Bytes | null,
    cache: cache as Bytes | null,
  };
}

export {
  collectArchive,
  readArchive,
  writeArchive,
  type ArchiveSink,
} from "./archive";
