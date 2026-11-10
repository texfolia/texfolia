import { z } from "zod";

import type { Engine } from "./jobs";
import { EngineError, HttpError } from "./project";
import {
  parseEngineTiming,
  unknownEngineTiming,
  emitCompileEvent,
} from "./telemetry";

const failure = z.object({ error: z.string(), log: z.string().optional() });

export function createEngineClient(
  fetchEngine: (request: Request) => Promise<Response>,
  baseUrl = "http://container",
): Engine {
  return async (project, context) => {
    const started = performance.now();
    let timing = unknownEngineTiming;
    try {
      const response = await fetchEngine(
        new Request(new URL("/compile", baseUrl).href, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "multipart/form-data",
            "X-Compilation-Id": context.jobId,
            "X-Compile-Attempt": String(context.attempt),
            "X-Compile-Plan": context.plan,
          },
          body: JSON.stringify(project),
          signal: AbortSignal.timeout(90_000),
        }),
      );
      timing = parseEngineTiming(response.headers.get("X-Compile-Timing"));
      if ([400, 408, 413, 422].includes(response.status)) {
        const detail = failure.parse(await response.json());
        throw new HttpError(response.status, detail.error, detail.log, timing);
      }
      if (!response.ok) throw new Error(`TeX host returned ${response.status}`);
      const form = await response.formData();
      const pdf = form.get("pdf");
      const log = form.get("log");
      if (!(pdf instanceof Blob) || typeof log !== "string")
        throw new Error("TeX host returned an invalid result");
      return { pdf: new Uint8Array(await pdf.arrayBuffer()), log, timing };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new EngineError(error, timing);
    } finally {
      emitCompileEvent({
        event: "compile_engine_request",
        ...context,
        ...timing,
        engineRequestMs: performance.now() - started,
      });
    }
  };
}
