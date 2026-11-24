import type { CompileRejection } from "@texfolia/contracts/compiler";
import { Schema } from "effect";

/** The request headers or body cannot be a compile. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { message: Schema.String, status: Schema.Literals([400, 413, 415]) },
) {}

/** An incremental request's container no longer holds its sources. */
export class ResyncRequired extends Schema.TaggedError<ResyncRequired>()(
  "ResyncRequired",
  {},
) {}

/** The compile was cancelled before a container ran it. */
export class CompileCancelled extends Schema.TaggedError<CompileCancelled>()(
  "CompileCancelled",
  {},
) {}

/** Too many compiles are already waiting. */
export class PoolSaturated extends Schema.TaggedError<PoolSaturated>()(
  "PoolSaturated",
  {},
) {}

/** No container became available in time. */
export class PoolUnavailable extends Schema.TaggedError<PoolUnavailable>()(
  "PoolUnavailable",
  { message: Schema.String },
) {}

/** A container could not be started, stopped, or reached. */
export class ContainerError extends Schema.TaggedError<ContainerError>()(
  "ContainerError",
  {
    operation: Schema.String,
    container: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type ClaimError =
  | ResyncRequired
  | CompileCancelled
  | PoolSaturated
  | PoolUnavailable;
export type CompileError = InvalidRequest | ClaimError | ContainerError;

const rejection = (
  status: number,
  body: CompileRejection,
  headers: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });

export function errorResponse(error: CompileError): Response {
  switch (error._tag) {
    case "InvalidRequest":
      return rejection(error.status, { error: error.message, code: "invalid" });
    case "ResyncRequired":
      return rejection(409, {
        error: "Source resync required",
        code: "resync",
      });
    case "CompileCancelled":
      return rejection(409, {
        error: "Compilation cancelled",
        code: "cancelled",
      });
    case "PoolSaturated":
      return rejection(
        503,
        { error: "Too many compiles are waiting", code: "saturated" },
        { "Retry-After": "5" },
      );
    case "PoolUnavailable":
      return rejection(
        503,
        { error: error.message, code: "unavailable" },
        { "Retry-After": "5" },
      );
    case "ContainerError":
      return rejection(
        503,
        { error: "The compile container failed", code: "unavailable" },
        { "Retry-After": "1" },
      );
  }
}
