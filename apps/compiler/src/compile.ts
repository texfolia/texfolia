import {
  compileArchiveType,
  compileHeaders,
  CompileOptions,
  compileOptionHeaders,
  type CompilePlacement,
} from "@texfolia/contracts/compiler";
import { Cause, Clock, Effect, Exit, Schema, Scope } from "effect";

import { Background } from "./background";
import { Containers } from "./containers";
import {
  type CompileError,
  ContainerError,
  errorResponse,
  InvalidRequest,
} from "./errors";
import { type Lease, Pool } from "./pool";

const maxRequestBytes = 64 * 1024 * 1024;
// Beyond the compile itself: the engine's limits for receiving sources and for
// rendering a preview.
const engineMarginMs = 90_000;
const responseTimeoutMs = 120_000;

const decodeOptions = Schema.decodeUnknownEffect(CompileOptions);

const parseRequest = Effect.fnUntraced(function* (request: Request) {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim() !==
    compileArchiveType
  )
    return yield* new InvalidRequest({
      message: `Expected ${compileArchiveType}`,
      status: 415,
    });
  if (!request.body)
    return yield* new InvalidRequest({
      message: "Expected compile sources",
      status: 400,
    });
  if (Number(request.headers.get("Content-Length") ?? 0) > maxRequestBytes)
    return yield* new InvalidRequest({
      message: "Compile sources exceed 64 MiB",
      status: 413,
    });
  return yield* decodeOptions(compileOptionHeaders(request.headers)).pipe(
    Effect.mapError(
      () =>
        new InvalidRequest({ message: "Invalid compile options", status: 400 }),
    ),
  );
});

// Stops whatever the engine runs for this compile. Reports whether the
// container answered, which decides whether it can be used again.
const cancelRun = Effect.fnUntraced(function* (container: string, id: string) {
  const containers = yield* Containers;
  return yield* containers
    .fetch(
      container,
      new Request(`http://container/compilations/${id}`, { method: "DELETE" }),
    )
    .pipe(
      Effect.tap((response) =>
        Effect.promise(async () => {
          await response.body?.cancel();
        }),
      ),
      Effect.map((response) => response.ok),
      Effect.timeout("5 seconds"),
      Effect.catch(() => Effect.succeed(false)),
    );
});

const engineAnswered = (response: Response) => {
  const type = response.headers.get("Content-Type") ?? "";
  return (
    type.startsWith(compileArchiveType) || type.startsWith("application/json")
  );
};

const engineRequest = (
  request: Request,
  options: CompileOptions,
  lease: Lease,
  signal?: AbortSignal,
) =>
  new Request("http://container/compile", {
    method: "POST",
    headers: {
      "Content-Type": compileArchiveType,
      [compileHeaders.id]: options.id,
      [compileHeaders.affinity]: options.affinity,
      [compileHeaders.timeoutMs]: String(options.timeoutMs),
      "X-Compile-Slot": String(lease.slot),
      "X-Compile-Generation": String(lease.generation),
      ...(request.headers.has("Content-Length")
        ? { "Content-Length": request.headers.get("Content-Length") ?? "" }
        : {}),
    },
    body: request.body,
    ...(signal ? { signal } : {}),
    // Required by runtimes that follow the Fetch standard for streamed bodies.
    duplex: "half",
  } as RequestInit);

/**
 * Sources and options in, artifacts out. The container is leased for exactly
 * one engine response and returned the moment its body has been delivered.
 */
export const compile = Effect.fnUntraced(function* (
  request: Request,
): Effect.fn.Return<Response, CompileError, Pool | Containers | Background> {
  const options = yield* parseRequest(request);
  const pool = yield* Pool;
  const containers = yield* Containers;
  const background = yield* Background;
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      // The scope outlives this handler: the streamed body closes it.
      const scope = yield* Scope.make();
      // Set when the container itself failed and must not be used again.
      let broken = false;
      const lease = yield* Effect.acquireRelease(
        restore(
          pool.claim({
            id: options.id,
            affinity: options.affinity,
            timeoutMs: options.timeoutMs,
            priority: options.priority,
            ...(options.container === undefined
              ? {}
              : { container: options.container }),
          }),
        ).pipe(
          // The claim may still be granted after its caller has gone.
          Effect.onInterrupt(() =>
            pool.release(options.id, { reusable: true }),
          ),
        ),
        (held, exit) =>
          Effect.suspend(() => {
            if (broken) return Effect.succeed(false);
            if (Exit.isSuccess(exit)) return Effect.succeed(true);
            return cancelRun(held.container, options.id).pipe(
              Effect.provideService(Containers, containers),
            );
          }).pipe(
            Effect.flatMap((reusable) =>
              pool.release(options.id, { reusable }),
            ),
          ),
      ).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      const waitMs = (yield* Clock.currentTimeMillis) - startedAt;
      const response = yield* restore(
        containers
          .fetch(lease.container, engineRequest(request, options, lease))
          .pipe(
            Effect.timeoutOrElse({
              duration: options.timeoutMs + engineMarginMs,
              orElse: () =>
                Effect.fail(
                  new ContainerError({
                    operation: "compile",
                    container: lease.container,
                    cause: new Error("The engine did not answer in time"),
                  }),
                ),
            }),
            // The platform answers for a container it could not reach.
            Effect.filterOrFail(
              engineAnswered,
              (failed) =>
                new ContainerError({
                  operation: "compile",
                  container: lease.container,
                  cause: new Error(`Container returned ${failed.status}`),
                }),
            ),
          ),
      ).pipe(
        // An interrupted request may leave the engine running; the lease's
        // finalizer stops it. The caller does not wait.
        Effect.onError((cause) =>
          Effect.sync(() => {
            broken = Cause.hasFails(cause);
            background.run(Scope.close(scope, Exit.failCause(cause)));
          }),
        ),
      );
      const placement: CompilePlacement = {
        container: lease.container,
        outcome: lease.outcome,
        waitMs,
      };
      yield* Effect.sync(() =>
        console.info({
          event: "compile_placement",
          telemetryVersion: 2,
          compileId: options.id,
          status: response.status,
          ...placement,
        }),
      );
      const headers = new Headers(response.headers);
      headers.set(compileHeaders.placement, JSON.stringify(placement));
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      // The engine itself failed, so the container cannot be trusted.
      broken = response.status >= 500;
      background.run(
        Effect.tryPromise((signal) =>
          (response.body ?? new Blob([]).stream()).pipeTo(stream.writable, {
            signal,
          }),
        ).pipe(
          Effect.timeout(responseTimeoutMs),
          Effect.exit,
          Effect.flatMap((exit) => Scope.close(scope, exit)),
        ),
      );
      return new Response(stream.readable, {
        status: response.status,
        headers,
      });
    }),
  );
});

/** Stops a compile that is waiting or running. Cancelling twice is harmless. */
export const cancel = Effect.fnUntraced(function* (id: string) {
  const pool = yield* Pool;
  const lease = yield* pool.cancel(id);
  // The running compile's own finalizer returns the container.
  if (lease) yield* cancelRun(lease.container, id);
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
});

const isCompileId = Schema.is(CompileOptions.fields.id);

/** The compiler's whole HTTP surface. */
export const handle = Effect.fnUntraced(function* (request: Request) {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/compile")
    return yield* compile(request).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (
            error._tag === "ContainerError" ||
            error._tag === "PoolUnavailable"
          )
            yield* Effect.logError("Compile could not run", error);
          return errorResponse(error);
        }),
      ),
    );
  const cancelled = /^\/compilations\/([^/]+)$/.exec(pathname)?.[1];
  if (request.method === "DELETE" && cancelled && isCompileId(cancelled))
    return yield* cancel(cancelled);
  if (request.method === "GET" && pathname === "/health")
    return Response.json(
      { status: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  return Response.json(
    { error: "Not found", code: "invalid" },
    { status: 404 },
  );
});

/**
 * Answers a request as a Promise. A caller that has gone is an ordinary outcome,
 * and the 499 sent to nobody is only for logs.
 */
export async function serve(
  request: Request,
  run: (
    program: ReturnType<typeof handle>,
    options: { signal: AbortSignal },
  ) => Promise<Exit.Exit<Response>>,
): Promise<Response> {
  const exit = await run(handle(request), { signal: request.signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (request.signal.aborted && Cause.hasInterruptsOnly(exit.cause))
    return new Response(null, { status: 499 });
  throw Cause.squash(exit.cause);
}
