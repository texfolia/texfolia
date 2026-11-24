import { afterEach, expect, test } from "bun:test";

import {
  encodeCompileHeaders,
  encodeCompileRequest,
  collectCompileArtifacts,
  readCompilePlacement,
  type CompileOptions,
  writeArchive,
} from "@texfolia/contracts/compiler";
import { Effect, Layer } from "effect";

import { Containers } from "../src/containers";
import { ContainerError } from "../src/errors";
import { createLocalCompiler } from "../src/local";
import { PoolStore } from "../src/pool";

const hash = "a".repeat(64);
const bytes = (text: string) => new TextEncoder().encode(text);
const success = () =>
  new Response(
    writeArchive(
      [
        ["output.pdf", "%PDF"],
        [
          "result.json",
          JSON.stringify({ log: "ok", pdf: "main.pdf", files: [] }),
        ],
      ].map(([name, text]) => ({
        name: name!,
        size: text!.length,
        content: bytes(text!),
      })),
    ).body,
    {
      headers: {
        "Content-Type": "application/x-tar",
        "X-Compile-Timing": "{}",
      },
    },
  );

type Engine = (container: string, request: Request) => Promise<Response>;
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const compiler of open.splice(0)) await compiler.close();
});

function harness(engine: Engine, variables: Record<string, string> = {}) {
  const requests: { container: string; method: string; path: string }[] = [];
  const stopped: string[] = [];
  const compiler = createLocalCompiler({
    variables,
    store: PoolStore.memory,
    maintenance: false,
    containers: Layer.succeed(Containers, {
      start: () => Effect.void,
      probe: () => Effect.void,
      stop: (name) => Effect.sync(() => void stopped.push(name)),
      fetch: (container, request) =>
        Effect.tryPromise({
          try: (signal) => {
            requests.push({
              container,
              method: request.method,
              path: new URL(request.url).pathname,
            });
            if (request.method === "DELETE") return engine(container, request);
            return Promise.race([
              engine(container, request),
              new Promise<never>((_, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason)),
              ),
            ]);
          },
          catch: (cause) =>
            new ContainerError({ operation: "fetch", container, cause }),
        }),
    }),
  });
  open.push(compiler);
  const post = (
    options: Partial<CompileOptions> = {},
    init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ) =>
    compiler.fetch(
      new Request("http://compiler/compile", {
        method: "POST",
        headers: {
          ...encodeCompileHeaders({
            id: crypto.randomUUID(),
            affinity: "project-a",
            timeoutMs: 1000,
            priority: 0,
            ...options,
          }),
          ...init.headers,
        },
        body: encodeCompileRequest({
          manifest: { mainFile: "main.tex", files: { "main.tex": hash } },
          blobs: [{ hash, size: 5, content: bytes("hello") }],
        }).body,
        signal: init.signal,
      }),
    );
  const leases = async () =>
    (await compiler.snapshot()).containers.flatMap((container) =>
      container.slots.flatMap((slot) => (slot.lease ? [slot.lease.id] : [])),
    );
  const released = async () => {
    const deadline = Date.now() + 2000;
    while ((await leases()).length) {
      if (Date.now() > deadline)
        throw new Error("The lease was never released");
      await Bun.sleep(1);
    }
  };
  return { ...compiler, post, requests, stopped, leases, released };
}

test("sources pass through unchanged and artifacts stream back with their placement", async () => {
  let received: Record<string, string | null> = {};
  let body: Uint8Array = new Uint8Array();
  const compiler = harness(async (_container, request) => {
    received = Object.fromEntries(
      ["Id", "Affinity", "Timeout-Ms", "Slot", "Generation"].map((name) => [
        name,
        request.headers.get(`X-Compile-${name}`),
      ]),
    );
    body = new Uint8Array(await request.arrayBuffer());
    return success();
  });
  const id = crypto.randomUUID();
  const response = await compiler.post({ id, timeoutMs: 4321 });
  expect(response.status).toBe(200);
  expect(received).toEqual({
    Id: id,
    Affinity: "project-a",
    "Timeout-Ms": "4321",
    Slot: "0",
    Generation: "1",
  });
  expect(new TextDecoder().decode(body)).toContain("hello");
  const placement = readCompilePlacement(response.headers);
  expect(placement).toMatchObject({ outcome: "cold" });
  expect(response.headers.get("X-Compile-Timing")).toBe("{}");
  expect((await collectCompileArtifacts(response.body!)).result.log).toBe("ok");
  await compiler.released();
  const next = await compiler.post({ container: placement!.container });
  expect(readCompilePlacement(next.headers)).toMatchObject({
    container: placement!.container,
    outcome: "affinity",
  });
  await next.arrayBuffer();
});

test("a container stays leased until its response is delivered, then returns without a reset call", async () => {
  const tail = Promise.withResolvers<void>();
  const data = new Uint8Array(await success().arrayBuffer());
  const compiler = harness(async (_container, request) => {
    await request.body?.cancel();
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(data.slice(0, 1024));
          await tail.promise;
          controller.enqueue(data.slice(1024));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "application/x-tar" } },
    );
  });
  const id = crypto.randomUUID();
  const response = await compiler.post({ id });
  const reader = response.body!.getReader();
  expect((await reader.read()).value?.length).toBe(1024);
  expect(await compiler.leases()).toEqual([id]);
  tail.resolve();
  while (!(await reader.read()).done);
  await compiler.released();
  expect(
    compiler.requests.map(({ method, path }) => `${method} ${path}`),
  ).toEqual(["POST /compile"]);
  expect(compiler.stopped).toEqual([]);
});

test.each([422, 409, 400, 413, 408])(
  "an engine answer of %i passes through and keeps its container",
  async (status) => {
    const compiler = harness(async (_container, request) => {
      await request.body?.cancel();
      return Response.json({ error: "x", code: "invalid" }, { status });
    });
    const response = await compiler.post();
    expect(response.status).toBe(status);
    await response.text();
    await compiler.released();
    expect(compiler.stopped).toEqual([]);
  },
);

test.each([
  [
    "an engine failure",
    async () =>
      Response.json({ error: "x", code: "internal" }, { status: 500 }),
    500,
  ],
  [
    "a platform answer",
    async () => new Response("There is no Container instance", { status: 503 }),
    503,
  ],
  [
    "an unreachable container",
    async () => {
      throw new Error("Network connection lost.");
    },
    503,
  ],
] satisfies [string, () => Promise<Response>, number][])(
  "%s replaces the container",
  async (_name, engine, status) => {
    const compiler = harness(async (_container, request) => {
      if (request.method === "DELETE")
        return new Response(null, { status: 500 });
      await request.body?.cancel();
      return engine();
    });
    const response = await compiler.post();
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code: expect.any(String) });
    await compiler.released();
    while ((await compiler.snapshot()).containers.length) await Bun.sleep(1);
    expect(compiler.stopped).toHaveLength(1);
  },
);

test("a caller that disconnects mid-compile stops the engine and returns the container", async () => {
  const started = Promise.withResolvers<void>();
  const compiler = harness(async (_container, request) => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    started.resolve();
    return new Promise<Response>(() => {});
  });
  const controller = new AbortController();
  const id = crypto.randomUUID();
  const pending = compiler.post({ id }, { signal: controller.signal });
  void pending.catch(() => {});
  await started.promise;
  controller.abort();
  await expect(pending).rejects.toThrow();
  await compiler.released();
  expect(compiler.requests.at(-1)).toMatchObject({
    method: "DELETE",
    path: `/compilations/${id}`,
  });
  expect(compiler.stopped).toEqual([]);
});

test("a caller that abandons the response body stops the engine", async () => {
  const compiler = harness(async (_container, request) => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    await request.body?.cancel();
    return new Response(
      new ReadableStream({
        pull: async (controller) => {
          controller.enqueue(new Uint8Array(1024));
          await Bun.sleep(1);
        },
      }),
      { headers: { "Content-Type": "application/x-tar" } },
    );
  });
  const response = await compiler.post();
  await response.body!.cancel();
  await compiler.released();
  expect(compiler.requests.at(-1)?.method).toBe("DELETE");
});

test("DELETE stops a running compile and a waiting one", async () => {
  const running = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const compiler = harness(
    async (_container, request) => {
      if (request.method === "DELETE") {
        running.resolve(
          Response.json({ error: "x", code: "cancelled" }, { status: 409 }),
        );
        return new Response(null, { status: 204 });
      }
      started.resolve();
      return running.promise;
    },
    { POOL_MAX_INSTANCES: "1" },
  );
  const cancel = (id: string) =>
    compiler.fetch(
      new Request(`http://compiler/compilations/${id}`, { method: "DELETE" }),
    );
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const active = compiler.post({ id: first });
  await started.promise;
  const waiting = compiler.post({ id: second, affinity: "project-b" });
  while ((await compiler.snapshot()).queued === 0) await Bun.sleep(1);
  expect((await cancel(second)).status).toBe(204);
  const cancelled = await waiting;
  expect(cancelled.status).toBe(409);
  expect(await cancelled.json()).toMatchObject({ code: "cancelled" });
  expect((await cancel(first)).status).toBe(204);
  expect((await active).status).toBe(409);
  await (await active).text();
  await compiler.released();
  expect((await cancel(crypto.randomUUID())).status).toBe(204);
  expect((await cancel("not-a-uuid")).status).toBe(404);
});

test("invalid requests never reach a container", async () => {
  const compiler = harness(async () => success());
  expect((await compiler.post({ affinity: "a/b" })).status).toBe(400);
  expect((await compiler.post({ timeoutMs: 300_001 })).status).toBe(400);
  expect(
    (
      await compiler.post(
        {},
        { headers: { "Content-Type": "application/json" } },
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await compiler.post(
        {},
        { headers: { "Content-Length": String(65 * 1024 * 1024) } },
      )
    ).status,
  ).toBe(413);
  const resync = await compiler.post({ container: "compiler-gone" });
  expect(resync.status).toBe(409);
  expect(await resync.json()).toMatchObject({ code: "resync" });
  expect(compiler.requests).toEqual([]);
  expect((await compiler.snapshot()).containers).toEqual([]);
});

test("a full queue answers 503 with a retry hint", async () => {
  const gate = Promise.withResolvers<void>();
  const compiler = harness(
    async () => {
      await gate.promise;
      return Response.json({ error: "x", code: "invalid" }, { status: 400 });
    },
    {
      POOL_MAX_INSTANCES: "1",
      POOL_MAX_QUEUED: "1",
    },
  );
  const running = compiler.post();
  while (compiler.requests.length === 0) await Bun.sleep(1);
  const waiting = compiler.post();
  while ((await compiler.snapshot()).queued === 0) await Bun.sleep(1);
  const response = await compiler.post();
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("5");
  expect(await response.json()).toMatchObject({ code: "saturated" });
  gate.resolve();
  await Promise.all(
    [running, waiting].map(async (held) => (await held).text()),
  );
});

test("only the compile, cancel and health routes exist", async () => {
  const compiler = harness(async () => success());
  const status = async (method: string, path: string) =>
    (await compiler.fetch(new Request(`http://compiler${path}`, { method })))
      .status;
  expect(await status("GET", "/health")).toBe(200);
  for (const path of [
    "/",
    "/projects/a",
    "/projects/a/events",
    "/projects/a/jobs/b",
    "/compile",
  ])
    expect(await status("GET", path)).toBe(404);
});
