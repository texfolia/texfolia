import {
  compileArchiveType,
  compileHeaders,
  compileIdSchema,
  compileOptionHeaders,
  compileOptionsSchema,
  type CompileOptions,
  type CompilePlacement,
} from "@texfolia/contracts/compiler";

import type { ContainerPlatform } from "./containers";
import { type CompileError, errorResponse } from "./errors";
import type { Lease, PoolClient } from "./pool";

const maxRequestBytes = 64 * 1024 * 1024;
// Beyond the compile itself: the engine's limits for receiving sources and for
// rendering a preview.
const engineMarginMs = 90_000;
const responseTimeoutMs = 120_000;
const cancelTimeoutMs = 5_000;

export type CompilerDeps = {
  pool: PoolClient;
  containers: ContainerPlatform;
  waitUntil: (task: Promise<unknown>) => void;
};

function parseRequest(
  request: Request,
): { ok: true; options: CompileOptions } | { ok: false; error: CompileError } {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim() !==
    compileArchiveType
  )
    return {
      ok: false,
      error: {
        code: "invalid",
        message: `Expected ${compileArchiveType}`,
        status: 415,
      },
    };
  if (!request.body)
    return {
      ok: false,
      error: {
        code: "invalid",
        message: "Expected compile sources",
        status: 400,
      },
    };
  if (Number(request.headers.get("Content-Length") ?? 0) > maxRequestBytes)
    return {
      ok: false,
      error: {
        code: "invalid",
        message: "Compile sources exceed 64 MiB",
        status: 413,
      },
    };
  const parsed = compileOptionsSchema.safeParse(
    compileOptionHeaders(request.headers),
  );
  if (!parsed.success)
    return {
      ok: false,
      error: {
        code: "invalid",
        message: "Invalid compile options",
        status: 400,
      },
    };
  return { ok: true, options: parsed.data };
}

// Stops whatever the engine runs for this compile. Reports whether the
// container answered, which decides whether it can be used again.
async function cancelRun(
  containers: ContainerPlatform,
  container: string,
  id: string,
): Promise<boolean> {
  try {
    const response = await containers.fetch(
      container,
      new Request(`http://container/compilations/${id}`, { method: "DELETE" }),
      AbortSignal.timeout(cancelTimeoutMs),
    );
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

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
    // Required by runtimes that follow the Fetch standard for streamed bodies.
    duplex: "half",
  } as RequestInit);

const respondError = (error: CompileError) => {
  if (error.code === "container" || error.code === "unavailable")
    console.error("Compile could not run", error);
  return errorResponse(error);
};

/**
 * Sources and options in, artifacts out. The container is leased for exactly
 * one engine response and returned the moment its body has been delivered.
 */
export async function compile(
  request: Request,
  { pool, containers, waitUntil }: CompilerDeps,
): Promise<Response> {
  const parsed = parseRequest(request);
  if (!parsed.ok) return respondError(parsed.error);
  const { options } = parsed;
  const startedAt = Date.now();
  const claimed = await pool.claim(
    {
      id: options.id,
      affinity: options.affinity,
      timeoutMs: options.timeoutMs,
      priority: options.priority,
      ...(options.container === undefined
        ? {}
        : { container: options.container }),
    },
    request.signal,
  );
  if (!claimed.ok) {
    if (request.signal.aborted) {
      // The claim may still have raced an abort on the remote side.
      waitUntil(pool.release(options.id, { reusable: true }));
      return new Response(null, { status: 499 });
    }
    return respondError(claimed);
  }
  const { lease } = claimed;
  if (request.signal.aborted) {
    waitUntil(pool.release(options.id, { reusable: true }));
    return new Response(null, { status: 499 });
  }

  const waitMs = Date.now() - startedAt;
  const fetchSignal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(options.timeoutMs + engineMarginMs),
  ]);
  let response: Response;
  try {
    response = await containers.fetch(
      lease.container,
      engineRequest(request, options, lease),
      fetchSignal,
    );
  } catch (cause) {
    if (request.signal.aborted) {
      waitUntil(
        cancelRun(containers, lease.container, options.id).then((reusable) =>
          pool.release(options.id, { reusable }),
        ),
      );
      return new Response(null, { status: 499 });
    }
    waitUntil(pool.release(options.id, { reusable: false }));
    return respondError({
      code: "container",
      operation: "compile",
      container: lease.container,
      cause,
    });
  }

  // The platform answers for a container it could not reach.
  if (!engineAnswered(response)) {
    await response.body?.cancel().catch(() => {});
    waitUntil(pool.release(options.id, { reusable: false }));
    return respondError({
      code: "container",
      operation: "compile",
      container: lease.container,
      cause: new Error(`Container returned ${response.status}`),
    });
  }

  const placement: CompilePlacement = {
    container: lease.container,
    outcome: lease.outcome,
    waitMs,
  };
  console.info({
    event: "compile_placement",
    telemetryVersion: 2,
    compileId: options.id,
    status: response.status,
    ...placement,
  });
  const headers = new Headers(response.headers);
  headers.set(compileHeaders.placement, JSON.stringify(placement));
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  // The engine itself failed, so the container cannot be trusted.
  const broken = response.status >= 500;
  waitUntil(
    (async () => {
      let delivered = false;
      try {
        await (response.body ?? new Blob([]).stream()).pipeTo(stream.writable, {
          signal: AbortSignal.timeout(responseTimeoutMs),
        });
        delivered = true;
      } catch {
        delivered = false;
      }
      const reusable = broken
        ? false
        : delivered
          ? true
          : await cancelRun(containers, lease.container, options.id);
      await pool.release(options.id, { reusable });
    })(),
  );
  return new Response(stream.readable, {
    status: response.status,
    headers,
  });
}

/** Stops a compile that is waiting or running. Cancelling twice is harmless. */
export async function cancel(
  id: string,
  { pool, containers }: Pick<CompilerDeps, "pool" | "containers">,
): Promise<Response> {
  const lease = await pool.cancel(id);
  // The running compile's own finalizer returns the container.
  if (lease) await cancelRun(containers, lease.container, id);
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

/** The compiler's whole HTTP surface. */
export async function handle(
  request: Request,
  deps: CompilerDeps,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/compile")
    return compile(request, deps);
  const cancelled = /^\/compilations\/([^/]+)$/.exec(pathname)?.[1];
  if (
    request.method === "DELETE" &&
    cancelled &&
    compileIdSchema.safeParse(cancelled).success
  )
    return cancel(cancelled, deps);
  if (request.method === "GET" && pathname === "/health")
    return Response.json(
      { status: "ready" },
      { headers: { "Cache-Control": "no-store" } },
    );
  return Response.json(
    { error: "Not found", code: "invalid" },
    { status: 404 },
  );
}
