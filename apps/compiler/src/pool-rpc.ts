import { Effect, Schema } from "effect";

import {
  CompileCancelled,
  PoolSaturated,
  PoolUnavailable,
  ResyncRequired,
} from "./errors";
import { ClaimRequest, Lease, type PoolClient } from "./pool";

// The pool lives in one Durable Object. Its RPC carries plain values, so typed
// errors cross as data and are rebuilt on the other side.
const ClaimReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), lease: Lease }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Literals([
      "ResyncRequired",
      "CompileCancelled",
      "PoolSaturated",
      "PoolUnavailable",
    ]),
    message: Schema.String,
  }),
]);
export type ClaimReply = typeof ClaimReply.Type;

export interface PoolRpc {
  claim(request: unknown): Promise<ClaimReply>;
  release(id: string, reusable: boolean): Promise<void>;
  locate(id: string): Promise<Lease | null>;
}

const decodeRequest = Schema.decodeUnknownEffect(ClaimRequest);
const decodeReply = Schema.decodeUnknownEffect(ClaimReply);
const decodeLocated = Schema.decodeUnknownEffect(Schema.NullOr(Lease));

/** The serving side of `claim`. */
export const serveClaim = (pool: PoolClient, input: unknown) =>
  decodeRequest(input).pipe(
    Effect.orDie,
    Effect.flatMap(pool.claim),
    Effect.match({
      onSuccess: (lease): ClaimReply => ({ ok: true, lease }),
      onFailure: (error): ClaimReply => ({
        ok: false,
        error: error._tag,
        message: error._tag === "PoolUnavailable" ? error.message : "",
      }),
    }),
  );

const unreachable = () =>
  new PoolUnavailable({ message: "The compile pool is unavailable" });

/** The calling side. A lost pool is an unavailable pool, never a defect. */
export function poolClient(rpc: PoolRpc): PoolClient {
  return {
    claim: Effect.fnUntraced(function* (request) {
      const reply = yield* Effect.tryPromise(() => rpc.claim(request)).pipe(
        Effect.flatMap(decodeReply),
        Effect.mapError(unreachable),
      );
      if (reply.ok) return reply.lease;
      switch (reply.error) {
        case "ResyncRequired":
          return yield* new ResyncRequired();
        case "CompileCancelled":
          return yield* new CompileCancelled();
        case "PoolSaturated":
          return yield* new PoolSaturated();
        case "PoolUnavailable":
          return yield* new PoolUnavailable({ message: reply.message });
      }
    }),
    // A release that cannot be delivered is recovered when its lease expires.
    release: (id, { reusable }) =>
      Effect.tryPromise(() => rpc.release(id, reusable)).pipe(
        Effect.catch((cause) =>
          Effect.logError("Compile lease release failed", { id, cause }),
        ),
      ),
    locate: (id) =>
      Effect.tryPromise(() => rpc.locate(id)).pipe(
        Effect.flatMap(decodeLocated),
        Effect.catch((cause) =>
          Effect.logError("Compile lookup failed", { id, cause }).pipe(
            Effect.as(null),
          ),
        ),
      ),
  };
}
