import {
  engineTimingSchema,
  unknownEngineTiming,
  type EngineTiming,
} from "@texfolia/contracts";

export function decodeTelemetry(value: string | null | undefined): unknown {
  try {
    return JSON.parse(value ?? "null");
  } catch {
    return null;
  }
}

export function parseEngineTiming(
  value: string | null | undefined,
): EngineTiming {
  const parsed = engineTimingSchema.safeParse(decodeTelemetry(value));
  return parsed.success ? parsed.data : unknownEngineTiming;
}

export function emitCompileEvent(
  event: {
    event: "compile_pool_claim" | "compile_engine_request" | "compile_backend";
    jobId: string;
  } & Record<string, unknown>,
) {
  console.info({ ...event, telemetryVersion: 1 });
}
