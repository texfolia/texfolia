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

import { pdfPath, storageConcurrency } from "./artifacts";
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

// A small source is read before the archive reaches it, a few at a time, so
// many small files cost one wait rather than one each. Larger ones are streamed
// when their turn comes. One connection is left for the cache archive.
const aheadBytes = 512 * 1024;
const aheadCount = storageConcurrency - 1;
type ReadSource = Parameters<Engine>[1]["readSource"];

function readSources(
  files: readonly SyncedProject["files"][string][],
  read: ReadSource,
) {
  const ahead = new Map<number, ReturnType<ReadSource>>();
  let next = 0;
  const fill = () => {
    for (; next < files.length && ahead.size < aheadCount; next++) {
      const file = files[next]!;
      if (file.size > aheadBytes) continue;
      const bytes = read(file).then(async (source) =>
        source instanceof Uint8Array
          ? source
          : new Uint8Array(await new Response(source).arrayBuffer()),
      );
      bytes.catch(() => {});
      ahead.set(next, bytes);
    }
  };
  return {
    fill,
    open(index: number) {
      const started = ahead.get(index);
      ahead.delete(index);
      next = Math.max(next, index + 1);
      fill();
      return started ?? read(files[index]!);
    },
  };
}

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
    const request = new AbortController();
    // A source that cannot be read fails the build, whatever the compiler says.
    const unreadable = Promise.withResolvers<never>();
    unreadable.promise.catch(() => {});
    const sources = readSources(files, async (file) => {
      try {
        return await context.readSource(file);
      } catch (error) {
        unreadable.reject(error);
        request.abort();
        throw error;
      }
    });
    // Start while the compiler finds a container.
    sources.fill();
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
        content: () => sources.open(index),
      })),
      ...(cache
        ? { cache: { size: cache.size, content: async () => cache.body } }
        : {}),
    }).body;
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
          (response) => response.body?.cancel(),
          (error: unknown) =>
            console.warn("Compile cancellation failed", { id, error }),
        )
        .finally(() => request.abort());
    };
    context.signal?.addEventListener("abort", cancel, { once: true });
    if (context.signal?.aborted) cancel();
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
        unreadable.promise,
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
        const { artifacts } = context;
        let sizeBytes = 0;
        let preview = false;
        const result = await readCompileArtifacts(response.body!, {
          ...artifacts,
          pdf(size) {
            sizeBytes = size;
            timing = { ...timing, firstPdfByteMs: performance.now() - started };
            return artifacts.pdf(size);
          },
          preview(size) {
            if (size > maxPreviewBytes)
              throw new Error("Compiler returned an invalid preview");
            preview = true;
            return artifacts.preview(size);
          },
        });
        context.signal?.throwIfAborted();
        // The container now holds exactly this build's sources and cache.
        if (placement && [200, 408, 422].includes(response.status))
          retained = {
            container: placement.container,
            hashes: new Set(
              Object.values(project.files).map((file) => file.hash),
            ),
            at: Date.now(),
          };
        if (result.pdf === undefined)
          throw new HttpError(
            response.status,
            result.error ?? "LaTeX compilation failed",
            result.log,
            timing,
          );
        // The PDF was already stored under this name.
        if (result.pdf !== pdfPath(project.mainFile))
          throw new Error("Compiler returned an unexpected PDF");
        if (project.preview && !preview)
          throw new Error("Compiler returned an invalid preview");
        return { sizeBytes, log: result.log, timing };
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
