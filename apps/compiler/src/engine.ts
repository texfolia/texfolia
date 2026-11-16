import { z } from "zod";

import type { Engine } from "./jobs";
import { compilePolicy } from "./limits";
import { firstPdfPart } from "./pdf-stream";
import {
  artifactPathSchema,
  artifactContentSchema,
  EngineError,
  HttpError,
} from "./project";
import type { SourceDelta, SyncedProject } from "./source-sync";
import {
  parseEngineTiming,
  unknownEngineTiming,
  emitCompileEvent,
} from "./telemetry";
import type { EngineTiming } from "./telemetry";

const failure = z.object({
  error: z.string(),
  log: z.string().optional(),
  logFile: artifactContentSchema
    .extend({ path: artifactPathSchema })
    .optional(),
});

export function createEngineClient(
  fetchEngine: (request: Request) => Promise<Response>,
  baseUrl = "http://container",
  prepare?: (context: Parameters<Engine>[1]) => {
    ready: Promise<unknown>;
    timing: Promise<Partial<EngineTiming>>;
  },
): Engine {
  let working: SyncedProject | null = null;
  return async (project, context) => {
    const started = performance.now();
    const timeoutMs = Math.min(
      context.timeoutMs ?? Infinity,
      compilePolicy(context.plan).timeoutMs,
    );
    let timing = unknownEngineTiming;
    let startup: Partial<EngineTiming> = {};
    try {
      context.signal?.throwIfAborted();
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        cancellation = fetchEngine(
          new Request(new URL(`/compilations/${context.jobId}`, baseUrl).href, {
            method: "DELETE",
            signal: AbortSignal.timeout(90_000),
          }),
        ).then((response) => {
          if (!response.ok) throw new Error("Engine cancellation failed");
        });
        // Observe failures immediately while the original engine request settles.
        void cancellation.catch(() => {});
      };
      context.signal?.addEventListener("abort", cancel, { once: true });
      let response: Response;
      try {
        const sync = "kind" in project ? project : null;
        if (
          sync &&
          working &&
          (sync.revision < working.revision ||
            (sync.revision === working.revision &&
              (sync.mainFile !== working.mainFile ||
                Object.keys(sync.files).length !==
                  Object.keys(working.files).length ||
                Object.entries(sync.files).some(
                  ([path, file]) => working?.files[path]?.hash !== file.hash,
                ))))
        )
          working = null;
        const delta = async (resync = false): Promise<SourceDelta> => {
          if (!sync || !context.readSource)
            throw new Error("Missing source store");
          const previous = resync ? null : working;
          const knownHashes = new Set(
            Object.values(previous?.files ?? {}).map((file) => file.hash),
          );
          const files: SourceDelta["files"] = {};
          for (const [path, file] of Object.entries(sync.files)) {
            if (previous?.files[path]?.hash !== file.hash) {
              Object.defineProperty(files, path, {
                value: {
                  hash: file.hash,
                  ...(knownHashes.has(file.hash)
                    ? {}
                    : { content: await context.readSource(file) }),
                },
                enumerable: true,
              });
              knownHashes.add(file.hash);
            }
          }
          return {
            mainFile: sync.mainFile,
            baseRevision: previous?.revision ?? 0,
            revision: sync.revision,
            files,
            deleted: Object.keys(previous?.files ?? {}).filter(
              (path) => !Object.hasOwn(sync.files, path),
            ),
            ...(resync ? { resync: true } : {}),
          };
        };
        const send = (sources: object) => {
          context.signal?.throwIfAborted();
          return fetchEngine(
            new Request(new URL("/compile", baseUrl).href, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "multipart/form-data",
                "X-Compilation-Id": context.jobId,
                "X-Compile-Attempt": String(context.attempt),
                "X-Compile-Plan": context.plan,
                ...(context.clean ? { "X-Clean-Compile": "1" } : {}),
                "X-Compile-Timeout-Ms": String(timeoutMs),
                ...(context.projectId
                  ? { "X-Project-Id": context.projectId }
                  : {}),
              },
              body: JSON.stringify({
                ...sources,
                ...(context.cache ? { cache: context.cache } : {}),
              }),
              signal: AbortSignal.timeout(timeoutMs + 90_000),
            }),
          );
        };
        const preparation = prepare?.(context);
        if (preparation) void preparation.timing.catch(() => {});
        await preparation?.ready;
        const [prepared, sources] = await Promise.all([
          preparation?.timing,
          sync ? delta(!working) : project,
        ]);
        startup = prepared ?? {};
        response = await send(sources);
        if (
          sync &&
          response.status === 409 &&
          response.headers.get("X-Source-Resync") === "1"
        ) {
          await response.body?.cancel();
          context.signal?.throwIfAborted();
          working = null;
          response = await send(await delta(true));
        }
        if (
          sync &&
          response.headers.get("X-Source-Revision") === String(sync.revision)
        )
          working = sync;
        else working = null;
      } finally {
        context.signal?.removeEventListener("abort", cancel);
        await cancellation;
      }
      timing = {
        ...parseEngineTiming(response.headers.get("X-Compile-Timing")),
        ...startup,
      };
      if (context.signal?.aborted) {
        await response.body?.cancel();
        context.signal.throwIfAborted();
      }
      if ([400, 408, 413, 422].includes(response.status)) {
        const detail = failure.parse(await response.json());
        throw new HttpError(
          response.status,
          detail.error,
          detail.log,
          timing,
          detail.logFile,
        );
      }
      if (!response.ok) throw new Error(`TeX host returned ${response.status}`);
      let persistedResponse = response;
      if (context.onPdf && response.body) {
        const [preview, persistence] = response.body.tee();
        persistedResponse = new Response(persistence, {
          headers: response.headers,
        });
        try {
          const pdf = await firstPdfPart(
            preview,
            response.headers.get("Content-Type") ?? "",
            () => {
              timing = {
                ...timing,
                firstPdfByteMs: performance.now() - started,
              };
            },
          );
          context.onPdf(pdf);
        } catch {}
      }
      const form = await persistedResponse.formData();
      const pdf = form.get("pdf");
      const log = form.get("log");
      const cacheArchive = form.get("cache");
      const preview = form.get("preview");
      if (
        "preview" in project &&
        project.preview &&
        (!(preview instanceof Blob) || preview.size > 4 * 1024 * 1024)
      )
        throw new Error("TeX host returned an invalid preview");
      if (!(pdf instanceof Blob) || typeof log !== "string")
        throw new Error("TeX host returned an invalid result");
      const files: Record<string, Blob> = {};
      const pdfPath = `${project.mainFile
        .split("/")
        .at(-1)!
        .replace(/\.tex$/, "")}.pdf`;
      files[pdfPath] = pdf;
      for (const [name, value] of form.entries()) {
        if (!name.startsWith("artifact:")) continue;
        const path = artifactPathSchema.parse(name.slice("artifact:".length));
        if (!(value instanceof Blob)) throw new Error("Invalid build artifact");
        files[path] = value;
      }
      const logPath = pdfPath.replace(/\.pdf$/, ".log");
      if (!files[logPath]) files[logPath] = new Blob([log]);
      return {
        pdf: new Uint8Array(await pdf.arrayBuffer()),
        log,
        timing,
        files,
        ...(cacheArchive instanceof Blob ? { cacheArchive } : {}),
        ...(preview instanceof Blob
          ? { preview: new Uint8Array(await preview.arrayBuffer()) }
          : {}),
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new EngineError(error, timing);
    } finally {
      emitCompileEvent({
        event: "compile_engine_request",
        jobId: context.jobId,
        projectId: context.projectId,
        attempt: context.attempt,
        plan: context.plan,
        ...timing,
        engineRequestMs: performance.now() - started,
      });
    }
  };
}
