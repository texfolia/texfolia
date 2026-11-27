import assert from "node:assert/strict";

import {
  compileHeaders,
  compileManifestSchema,
  compileOptionsSchema,
  compileOptionHeaders,
  collectArchive,
  writeArchive,
  type CompileManifest,
  type CompileOptions,
} from "@texfolia/contracts/compiler";

const decodeOptions = (input: unknown) => compileOptionsSchema.parse(input);
const decodeManifest = (text: string) =>
  compileManifestSchema.parse(JSON.parse(text));
const encode = (value: string | Uint8Array) =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

export type FixtureRequest = {
  options: CompileOptions;
  manifest: CompileManifest;
  /** Every source the engine would compile. */
  sources: Record<string, Uint8Array>;
  /** Hashes whose content this request carried. */
  received: string[];
  cache: Uint8Array | null;
};
export type FixtureOutput = {
  status?: 200 | 408 | 413 | 422;
  error?: string;
  pdf?: string | Uint8Array;
  log?: string;
  files?: Record<string, string | Uint8Array>;
  preview?: Uint8Array;
  cache?: string | Uint8Array;
  timing?: Record<string, unknown>;
};

/** A compile response in the wire's own archive format. */
export function fixtureResponse(
  manifest: Pick<CompileManifest, "mainFile">,
  output: FixtureOutput,
  headers: Record<string, string> = {},
) {
  const name = (manifest.mainFile.split("/").at(-1) ?? "").replace(
    /\.tex$/,
    "",
  );
  const files = Object.entries(output.files ?? {});
  const entries: [string, Uint8Array][] = [];
  if (output.pdf !== undefined)
    entries.push(["output.pdf", encode(output.pdf)]);
  entries.push([
    "result.json",
    encode(
      JSON.stringify({
        log: output.log ?? "",
        files: files.map(([path]) => path),
        ...(output.error === undefined ? {} : { error: output.error }),
        ...(output.pdf === undefined ? {} : { pdf: `${name}.pdf` }),
      }),
    ),
  ]);
  if (output.preview) entries.push(["preview.png", output.preview]);
  for (const [index, [, content]] of files.entries())
    entries.push([`artifacts/${index}`, encode(content)]);
  if (output.cache !== undefined)
    entries.push(["cache.tar.zst", encode(output.cache)]);
  return new Response(
    writeArchive(
      entries.map(([name, content]) => ({
        name,
        size: content.length,
        content,
      })),
    ).body,
    {
      status: output.status ?? (output.pdf === undefined ? 422 : 200),
      headers: {
        "Content-Type": "application/x-tar",
        [compileHeaders.timing]: JSON.stringify(
          output.timing ?? {
            engine: "tectonic",
            temperature: "warm",
            inputPrepMs: 1,
            compileMs: 1,
            outputMs: 1,
          },
        ),
        ...headers,
      },
    },
  );
}

/**
 * The compiler's HTTP surface over a fixture engine. Like a real container, it
 * keeps each affinity's sources and answers `resync` when it lacks one.
 */
export function createCompilerFixture(
  compile: (
    request: FixtureRequest,
  ) => Promise<FixtureOutput | Response> | FixtureOutput | Response,
) {
  let container = "compiler-1";
  const retained = new Map<string, Map<string, Uint8Array>>();
  const cancelled: string[] = [];
  const requests: FixtureRequest[] = [];
  const resync = (missing: string[] = []) =>
    Response.json(
      { error: "Source resync required", code: "resync", missing },
      { status: 409 },
    );
  return {
    requests,
    cancelled,
    /** Replaces the container, as a drain or a deploy does. */
    restart() {
      container = `compiler-${crypto.randomUUID()}`;
      retained.clear();
    },
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const { pathname } = new URL(path, "http://compiler");
      if (init.method === "DELETE") {
        cancelled.push(pathname.split("/").at(-1) ?? "");
        return new Response(null, { status: 204 });
      }
      assert.equal(pathname, "/compile");
      const request = new Request("http://compiler/compile", init);
      const options = decodeOptions(compileOptionHeaders(request.headers));
      if (options.container !== undefined && options.container !== container)
        return resync();
      assert(request.body);
      const entries = await collectArchive(request.body, {
        maxBytes: 64 * 1024 * 1024,
      });
      const manifest = decodeManifest(
        new TextDecoder().decode(entries.get("manifest.json")),
      );
      const blobs =
        retained.get(options.affinity) ?? new Map<string, Uint8Array>();
      const received: string[] = [];
      for (const [name, content] of entries)
        if (name.startsWith("blobs/")) {
          const hash = name.slice("blobs/".length);
          received.push(hash);
          blobs.set(hash, content);
        }
      const missing = Object.values(manifest.files).filter(
        (hash) => !blobs.has(hash),
      );
      if (missing.length) return resync(missing);
      retained.set(options.affinity, blobs);
      const sources: Record<string, Uint8Array> = {};
      for (const [path, hash] of Object.entries(manifest.files))
        Object.defineProperty(sources, path, {
          enumerable: true,
          value: blobs.get(hash),
        });
      const parsed = {
        options,
        manifest,
        sources,
        received,
        cache: entries.get("cache.tar.zst") ?? null,
      };
      requests.push(parsed);
      const output = await compile(parsed);
      const placement = JSON.stringify({
        container,
        outcome: options.container === undefined ? "spare" : "affinity",
        waitMs: 1,
      });
      if (!(output instanceof Response))
        return fixtureResponse(manifest, output, {
          [compileHeaders.placement]: placement,
        });
      const headers = new Headers(output.headers);
      headers.set(compileHeaders.placement, placement);
      return new Response(output.body, { status: output.status, headers });
    },
  };
}
