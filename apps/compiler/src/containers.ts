import { Context, type Effect } from "effect";

import type { ContainerError } from "./errors";

/** The container platform: Cloudflare Containers, or Docker in development. */
export class Containers extends Context.Service<
  Containers,
  {
    /** Starts a container and waits until it serves requests. */
    start(name: string): Effect.Effect<void, ContainerError>;
    /** Fails when a running container no longer serves requests. */
    probe(name: string): Effect.Effect<void, ContainerError>;
    stop(name: string): Effect.Effect<void, ContainerError>;
    fetch(
      name: string,
      request: Request,
    ): Effect.Effect<Response, ContainerError>;
  }
>()("compiler/Containers") {}
