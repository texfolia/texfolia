import { type EngineTiming, unknownEngineTiming } from "@texfolia/contracts";
import {
  compileArchiveType,
  compileHeaders,
  encodeCompileHeaders,
  encodeCompileRequest,
  maxCacheArchiveBytes,
  maxPreviewBytes,
  readCompileArtifacts,
  readCompilePlacement,
  readCompileRejection,
} from "@texfolia/contracts/compiler";

import { mapLimit } from "#/lib/map-limit";

import { storageConcurrency } from "./artifacts";
import { compilePolicy } from "./limits";
import { EngineError, HttpError } from "./project";
import type { SyncedProject } from "./source-sync";
import { emitCompileEvent, parseEngineTiming } from "./telemetry";
import type { Engine, ObjectStore } from "./types";

export type FetchCompiler = (
  path: string,
  init: RequestInit,
) => Promise<Response>;

/** Calls the private compiler Worker, or the local process in development. */
export async function fetchCompiler(
  path: string,
  init: RequestInit,
  compiler?: Pick<Fetcher, "fetch">,
) {
  const options: RequestInit = { ...init, redirect: "manual" };
  const response = import.meta.env.DEV
    ? await fetch(
        new URL(path, process.env.COMPILER_URL ?? "http://localhost:8080"),
        options,
      )
    : await (
        compiler ?? (await import("cloudflare:workers")).env.COMPILER
      ).fetch(new URL(path, "http://compiler"), options);
  if (response.status >= 300 && response.status < 400)
    throw new Error("Compiler returned an unexpected redirect");
  return response;
}

// Waiting for a container, receiving sources, and delivering artifacts.
const requestMarginMs = 180_000;
const cancelTimeoutMs = 10_000;
// Shorter than the compiler's idle drain, so a container that is probably gone
// is not asked for.
const retainedMs = 9 * 60_000;

type Retained = { container: string; hashes: Set<string>; at: number };

/**
 * Runs builds of one project on the compiler. It remembers which container ran
 * the last build and sends that container only the sources that changed.
 */
export function createCompilerEngine(options: {
  projectId: string;
  store: Pick<ObjectStore, "open">;
  cacheKey: string;
  fetch: FetchCompiler;
  pause?: (ms: number) => Promise<void>;
}): Engine {
  const pause =
    options.pause ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let retained: Retained | null = null;

  async function cacheArchive(timing: Partial<EngineTiming>) {
    const started = performance.now();
    try {
      const archive = await options.store.open(options.cacheKey);
      if (archive && archive.size <= maxCacheArchiveBytes) {
        timing.archiveFetchMs = performance.now() - started;
        return archive;
      }
      await archive?.body.cancel();
    } catch (error) {
      timing.archiveStatus = "unavailable";
      console.warn("Cache archive fetch failed; compiling without it", {
        projectId: options.projectId,
        error,
      });
    }
    timing.archiveFetchMs = performance.now() - started;
    return null;
  }

  async function send(
    project: SyncedProject,
    context: Parameters<Engine>[1],
    timeoutMs: number,
    previous: Retained | null,
    timing: Partial<EngineTiming>,
  ) {
    const id = crypto.randomUUID();
    const missing = new Map(
      Object.values(project.files)
        .filter((file) => !previous?.hashes.has(file.hash))
        .map((file) => [file.hash, file]),
    );
    const files = [...missing.values()];
    // Read sources while the compiler finds a container.
    const loaded = mapLimit(files, storageConcurrency, context.readSource);
    const cache = previous || context.clean ? null : await cacheArchive(timing);
    const body = encodeCompileRequest({
      manifest: {
        mainFile: project.mainFile,
        files: Object.fromEntries(
          Object.entries(project.files).map(([path, file]) => [
            path,
            file.hash,
          ]),
        ),
        ...(context.clean ? { clean: true } : {}),
        ...(project.preview ? { preview: true } : {}),
        ...(previous ? { incremental: true } : {}),
      },
      blobs: files.map(({ hash, size }, index) => ({
        hash,
        size,
        content: async () => (await loaded)[index]!,
      })),
      ...(cache
        ? { cache: { size: cache.size, content: async () => cache.body } }
        : {}),
    }).body;
    const request = new AbortController();
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      // Stop the engine first, so a cancelled compile never holds a container
      // while its caller has already moved on.
      cancellation = options
        .fetch(`/compilations/${id}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(cancelTimeoutMs),
        })
        .then(
          async (response) => void (await response.body?.cancel()),
          (error: unknown) =>
            console.warn("Compile cancellation failed", { id, error }),
        )
        .finally(() => request.abort());
    };
    context.signal?.addEventListener("abort", cancel, { once: true });
    if (context.signal?.aborted) cancel();
    // A source that cannot be read fails the build, whatever the compiler says.
    const unreadable = new Promise<never>((_, reject) =>
      loaded.catch((error: unknown) => {
        request.abort();
        reject(error);
      }),
    );
    const finish = async () => {
      context.signal?.removeEventListener("abort", cancel);
      await cancellation;
      await cache?.body.cancel().catch(() => {});
    };
    try {
      const response = await Promise.race([
        options.fetch("/compile", {
          method: "POST",
          headers: encodeCompileHeaders({
            id,
            affinity: options.projectId,
            timeoutMs,
            priority: compilePolicy(context.plan).priority,
            ...(previous ? { container: previous.container } : {}),
          }),
          body,
          duplex: "half",
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(timeoutMs + requestMarginMs),
          ]),
        } as RequestInit),
        unreadable,
      ]);
      return { response, finish };
    } catch (error) {
      await finish();
      throw error;
    }
  }

  return async (project, context) => {
    const started = performance.now();
    const policy = compilePolicy(context.plan);
    const timeoutMs = Math.max(
      1,
      Math.min(context.timeoutMs ?? Infinity, policy.timeoutMs),
    );
    let timing = unknownEngineTiming;
    const startup: Partial<EngineTiming> = {};
    try {
      context.signal?.throwIfAborted();
      if (policy.yieldMs) await pause(policy.yieldMs);
      context.signal?.throwIfAborted();
      const previous =
        retained && Date.now() - retained.at < retainedMs ? retained : null;
      retained = null;
      let attempt = await send(project, context, timeoutMs, previous, startup);
      if (
        (previous && attempt.response.status === 409) ||
        attempt.response.status === 503
      ) {
        const rejection = await readCompileRejection(attempt.response);
        await attempt.finish();
        context.signal?.throwIfAborted();
        // The container was reassigned, or it failed. Any other will do once.
        if (rejection?.code !== "resync" && rejection?.code !== "unavailable")
          throw new Error(
            rejection?.error ?? `Compiler returned ${attempt.response.status}`,
          );
        attempt = await send(project, context, timeoutMs, null, startup);
      }
      const { response, finish } = attempt;
      try {
        const placement = readCompilePlacement(response.headers);
        const engine = parseEngineTiming(
          response.headers.get(compileHeaders.timing),
        );
        timing = {
          ...engine,
          ...startup,
          ...(placement
            ? {
                containerStartMs: placement.waitMs,
                prewarmed: placement.outcome === "spare",
              }
            : {}),
        };
        if (context.signal?.aborted) {
          await response.body?.cancel();
          context.signal.throwIfAborted();
        }
        const archive =
          response.body &&
          response.headers.get("Content-Type")?.startsWith(compileArchiveType);
        if (!archive) {
          const rejection = await readCompileRejection(response);
          if (response.status === 400)
            throw new HttpError(
              400,
              rejection?.error ?? "Invalid project sources",
              "",
              timing,
            );
          throw new Error(
            rejection?.error ?? `Compiler returned ${response.status}`,
          );
        }
        const output = await readCompileArtifacts(
          response.body!,
          response.status === 200 && context.onPdf
            ? (pdf) => {
                timing = {
                  ...timing,
                  firstPdfByteMs: performance.now() - started,
                };
                context.onPdf?.(pdf);
              }
            : undefined,
        );
        context.signal?.throwIfAborted();
        const { result } = output;
        // The container now holds exactly this build's sources and cache.
        if (placement && [200, 408, 422].includes(response.status))
          retained = {
            container: placement.container,
            hashes: new Set(
              Object.values(project.files).map((file) => file.hash),
            ),
            at: Date.now(),
          };
        if (!output.pdf || result.pdf === undefined) {
          const [path, content] = [...output.files][0] ?? [];
          throw new HttpError(
            response.status,
            result.error ?? "LaTeX compilation failed",
            result.log,
            timing,
            path !== undefined && content ? { path, content } : undefined,
          );
        }
        if (
          project.preview &&
          (!output.preview || output.preview.byteLength > maxPreviewBytes)
        )
          throw new Error("Compiler returned an invalid preview");
        const files: Record<string, Uint8Array> = { [result.pdf]: output.pdf };
        for (const [path, content] of output.files) files[path] = content;
        const logPath = result.pdf.replace(/\.pdf$/, ".log");
        files[logPath] ??= new TextEncoder().encode(result.log);
        return {
          pdf: output.pdf,
          log: result.log,
          timing,
          files,
          ...(output.cache ? { cacheArchive: output.cache } : {}),
          ...(output.preview ? { preview: output.preview } : {}),
        };
      } finally {
        await finish();
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new EngineError(error, timing);
    } finally {
      emitCompileEvent({
        event: "compile_engine_request",
        jobId: context.jobId,
        projectId: options.projectId,
        attempt: context.attempt,
        plan: context.plan,
        ...timing,
        engineRequestMs: performance.now() - started,
      });
    }
  };
}
