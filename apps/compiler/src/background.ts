import { Context, type Effect } from "effect";

/**
 * Keeps this process running for work that outlives the request that began it,
 * such as returning or stopping a container.
 */
export class Background extends Context.Service<
  Background,
  { run(effect: Effect.Effect<void>): void }
>()("compiler/Background") {}
