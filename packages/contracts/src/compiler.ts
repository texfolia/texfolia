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

import { readArchive, writeArchive, type ArchiveEntry } from "./archive";
import { maxPdfBytes } from "./builds";

export const maxCompileTimeoutMs = 300_000;
export const maxSourceBytes = 10 * 1024 * 1024;
export const maxCacheArchiveBytes = 33 * 1024 * 1024;
export const maxPreviewBytes = 4 * 1024 * 1024;
export const compileArchiveType = "application/x-tar";
// The PDF, 32 MiB of artifacts, the cache archive, and archive overhead.
const maxResponseBytes = 96 * 1024 * 1024;

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

export type CompileArtifacts = {
  result: CompileResult;
  pdf: Uint8Array<ArrayBuffer> | null;
  files: Map<string, Uint8Array<ArrayBuffer>>;
  preview: Uint8Array<ArrayBuffer> | null;
  cache: Uint8Array<ArrayBuffer> | null;
};

/**
 * Reads a whole compile response. `onPdf` receives the PDF as it arrives, long
 * before the remaining artifacts; a slow or cancelled consumer never delays
 * them.
 */
export async function readCompileArtifacts(
  body: ReadableStream<Uint8Array>,
  onPdf?: (pdf: ReadableStream<Uint8Array>) => void,
): Promise<CompileArtifacts> {
  let first = true;
  const entries = await readArchive(body, {
    maxBytes: maxResponseBytes,
    visit: ({ name, size }) => {
      const leading = first;
      first = false;
      if (name !== "output.pdf") return undefined;
      if (!leading) throw new Error("The compiler must send the PDF first");
      if (!size) throw new Error("The compiler returned an empty PDF");
      if (size > maxPdfBytes) throw new Error("The PDF exceeds 20 MiB");
      if (!onPdf) return undefined;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      onPdf(
        new ReadableStream<Uint8Array>({
          start: (value) => {
            controller = value;
          },
          cancel: () => {
            controller = undefined;
          },
        }),
      );
      return {
        chunk: (bytes) => controller?.enqueue(bytes.slice()),
        end: () => controller?.close(),
        error: (cause) => controller?.error(cause),
      };
    },
  });
  const encoded = entries.get("result.json");
  if (!encoded) throw new Error("The compiler returned no result");
  const result = decodeResult(new TextDecoder().decode(encoded));
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [index, path] of result.files.entries()) {
    const content = entries.get(`artifacts/${index}`);
    if (!content) throw new Error("The compiler omitted an artifact");
    files.set(path, content);
  }
  const pdf = entries.get("output.pdf") ?? null;
  if ((pdf === null) !== (result.pdf === undefined))
    throw new Error("The compiler result does not match its PDF");
  return {
    result,
    pdf,
    files,
    preview: entries.get("preview.png") ?? null,
    cache: entries.get("cache.tar.zst") ?? null,
  };
}

export { readArchive, writeArchive } from "./archive";
