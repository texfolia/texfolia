import type { CompileRejection } from "@texfolia/contracts/compiler";

export type ClaimError =
  | { readonly code: "resync" }
  | { readonly code: "cancelled" }
  | { readonly code: "saturated" }
  | { readonly code: "unavailable"; readonly message: string };

export type CompileError =
  | ClaimError
  | {
      readonly code: "invalid";
      readonly message: string;
      readonly status: 400 | 413 | 415;
    }
  | {
      readonly code: "container";
      readonly operation: string;
      readonly container: string;
      readonly cause: unknown;
    };

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
  switch (error.code) {
    case "invalid":
      return rejection(error.status, { error: error.message, code: "invalid" });
    case "resync":
      return rejection(409, {
        error: "Source resync required",
        code: "resync",
      });
    case "cancelled":
      return rejection(409, {
        error: "Compilation cancelled",
        code: "cancelled",
      });
    case "saturated":
      return rejection(
        503,
        { error: "Too many compiles are waiting", code: "saturated" },
        { "Retry-After": "5" },
      );
    case "unavailable":
      return rejection(
        503,
        { error: error.message, code: "unavailable" },
        { "Retry-After": "5" },
      );
    case "container":
      return rejection(
        503,
        { error: "The compile container failed", code: "unavailable" },
        { "Retry-After": "1" },
      );
  }
}
