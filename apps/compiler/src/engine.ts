import { z } from "zod";

import type { Engine } from "./jobs";
import {
  artifactPathSchema,
  artifactContentSchema,
  EngineError,
  HttpError,
} from "./project";
import {
  parseEngineTiming,
  unknownEngineTiming,
  emitCompileEvent,
} from "./telemetry";

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
): Engine {
  return async (project, context) => {
    const started = performance.now();
    let timing = unknownEngineTiming;
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
        response = await fetchEngine(
          new Request(new URL("/compile", baseUrl).href, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "multipart/form-data",
              "X-Compilation-Id": context.jobId,
              "X-Compile-Attempt": String(context.attempt),
              "X-Compile-Plan": context.plan,
              ...(context.projectId
                ? { "X-Project-Id": context.projectId }
                : {}),
            },
            body: JSON.stringify({
              ...project,
              ...(context.cache ? { cache: context.cache } : {}),
            }),
            signal: AbortSignal.timeout(90_000),
          }),
        );
      } finally {
        context.signal?.removeEventListener("abort", cancel);
        await cancellation;
      }
      if (context.signal?.aborted) {
        await response.body?.cancel();
        context.signal.throwIfAborted();
      }
      timing = parseEngineTiming(response.headers.get("X-Compile-Timing"));
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
      const form = await response.formData();
      const pdf = form.get("pdf");
      const log = form.get("log");
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
