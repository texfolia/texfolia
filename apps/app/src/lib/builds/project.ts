import { type EngineTiming, unknownEngineTiming } from "@texfolia/contracts";
import { z } from "zod";

import type { LogFile } from "./types";

export const maxProjectBytes = 10 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public log = "",
    public timing: EngineTiming = unknownEngineTiming,
    public logFile?: LogFile,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

// The compiler could not run the build. Such builds are retried.
export class EngineError extends Error {
  constructor(
    cause: unknown,
    public timing: EngineTiming,
  ) {
    super(
      cause instanceof Error ? cause.message : "The compiler request failed",
      { cause },
    );
  }
}

// A saved source left the bucket after the build was accepted.
export class MissingSourceError extends HttpError {
  constructor() {
    super(409, "Project sources changed while compiling. Compile again.");
  }
}

export const base64ContentSchema = z.object({
  base64: z
    .string()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((value) => value.length % 4 === 0, "Invalid base64 content"),
});
