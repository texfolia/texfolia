import { expect, test } from "bun:test";

import { PoolCore, type PoolClaim } from "../src/pool";
import { createPooledEngine } from "../src/pooled-engine";
import type { Engine, ObjectStore } from "../src/types";

function fixture() {
  const claims = new Map<string, PoolClaim>();
  const archives = new Map<string, string>();
  const restored: { projectId: string; archive: string }[] = [];
  const released: string[] = [];
  const compiled: string[] = [];
  const discarded: string[] = [];
  let tail = Promise.resolve();
  let status = 200;
  let claimFails = false;
  let prewarms = 0;
  const store: ObjectStore = {
    async read(key) {
      return archives.has(key) ? new Response(archives.get(key)).body : null;
    },
    async head() {
      return null;
    },
    async create() {
      return true;
    },
    async write() {},
    async remove() {},
    async *keys() {},
  };
  const sessions = new Map<
    string,
    { token: string; projectId: string; cacheReady: boolean }
  >();
  const pool = new PoolCore({
    saved: null,
    save() {},
    lookup: (key) => claims.get(key),
    assign: (key, claim) => {
      claims.set(key, claim);
    },
    async start() {},
    async stop() {},
    async reset(name, token) {
      expect(sessions.get(name)?.token).toBe(token);
      released.push(name);
      sessions.delete(name);
    },
    now: Date.now,
    pause: async () => {},
  });
  const engine = (projectId: string) =>
    createPooledEngine({
      projectId,
      store,
      async claim(plan, id) {
        if (claimFails) throw new Error("pool unavailable");
        return pool.claim(projectId, plan, id);
      },
      release: (id) => pool.release(projectId, id),
      async discard(name) {
        discarded.push(name);
        sessions.delete(name);
      },
      async prewarm() {
        prewarms++;
        await pool.maintain();
      },
      async fetch(name, request) {
        const token = request.headers.get("X-Container-Lease");
        if (!token) throw new Error("Missing lease token");
        const path = new URL(request.url).pathname;
        if (path === "/lease") {
          expect(sessions.has(name)).toBe(false);
          sessions.set(name, { token, projectId, cacheReady: false });
          return new Response(null, { status: 204 });
        }
        const session = sessions.get(name);
        if (!session || session.token !== token)
          return new Response(null, { status: 409 });
        if (path === "/health")
          return Response.json({
            bootId: name,
            cacheReady: session.cacheReady,
            bootMs: 1,
            imageSizeBytes: null,
          });
        expect(request.headers.get("X-Project-Id")).toBe(projectId);
        if (path === "/cache") {
          session.cacheReady = true;
          restored.push({ projectId, archive: await request.text() });
          return Response.json({ archiveUnpackMs: 1 });
        }
        expect(path).toBe("/compile");
        compiled.push(name);
        if (status !== 200)
          return Response.json(
            { error: "Invalid TeX", log: "failed" },
            {
              status,
              headers: {
                "X-Compile-Timing": '{"engine":"tectonic","cacheUsed":true}',
              },
            },
          );
        const form = new FormData();
        form.set("pdf", new Blob(["%PDF-1.5"]), "main.pdf");
        form.set("log", "compiled");
        form.set("cache", new Blob([`${projectId} archive`]), "cache.tar.zst");
        const response = new Response(form);
        const headers = new Headers(response.headers);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(bytes.slice(0, -10));
            await tail;
            controller.enqueue(bytes.slice(-10));
            controller.close();
          },
        });
        return new Response(body, { headers });
      },
    });
  const context = (): Parameters<Engine>[1] => ({
    jobId: crypto.randomUUID(),
    plan: "pro",
    attempt: 1,
  });
  const project = { mainFile: "main.tex", files: { "main.tex": "source" } };
  return {
    pool,
    engine,
    context,
    project,
    archives,
    restored,
    released,
    compiled,
    discarded,
    prewarms: () => prewarms,
    holdTail: (gate: Promise<void>) => {
      tail = gate;
    },
    fail: (value: number) => {
      status = value;
    },
    failClaim: () => {
      claimFails = true;
    },
  };
}

test("editor prewarm claims no lease; A, B, then A reuse one process with each project's own archive", async () => {
  const f = fixture();
  const a = f.engine("a"),
    b = f.engine("b");
  await a.prewarm?.();
  await b.prewarm?.();
  expect(f.prewarms()).toBe(2);
  expect(f.pool.snapshot().leases).toHaveLength(0);
  f.archives.set("projects/a/cache.tar.zst", "a cached");
  f.archives.set("projects/b/cache.tar.zst", "b cached");
  const first = await a(f.project, f.context());
  f.archives.set("projects/a/cache.tar.zst", await first.cacheArchive!.text());
  await b(f.project, f.context());
  await a(f.project, f.context());
  expect(new Set(f.compiled).size).toBe(1);
  expect(f.restored).toEqual([
    { projectId: "a", archive: "a cached" },
    { projectId: "b", archive: "b cached" },
    { projectId: "a", archive: "a archive" },
  ]);
  expect(f.released).toEqual(f.compiled);
  expect(f.pool.snapshot().leases).toHaveLength(0);
});

test("a lease stays exclusive until the multipart response tail has been consumed", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  f.holdTail(gate.promise);
  const first = f.engine("a")(f.project, f.context());
  for (let i = 0; i < 100 && f.compiled.length === 0; i++) await Bun.sleep(1);
  expect(f.compiled).toHaveLength(1);
  expect(f.released).toHaveLength(0);
  expect((await f.pool.claim("b", "pro", "other")).container).not.toBe(
    f.compiled[0],
  );
  gate.resolve();
  await first;
  expect(f.released).toEqual(f.compiled);
});

test("clean builds bypass archived cache and failed TeX releases the container", async () => {
  const f = fixture();
  f.archives.set("projects/a/cache.tar.zst", "must not restore");
  const engine = f.engine("a");
  await engine(f.project, { ...f.context(), clean: true });
  expect(f.restored).toEqual([{ projectId: "a", archive: "" }]);
  f.fail(422);
  await expect(engine(f.project, f.context())).rejects.toThrow("Invalid TeX");
  expect(f.released).toHaveLength(2);
  expect(f.pool.snapshot().leases).toHaveLength(0);
  f.fail(200);
  await engine(f.project, { ...f.context(), clean: true });
  expect(new Set(f.compiled).size).toBe(1);
});

test("pool RPC failure uses an ephemeral cold container and destroys it after the job", async () => {
  const f = fixture();
  f.failClaim();
  await f.engine("a")(f.project, f.context());
  expect(f.discarded).toEqual(f.compiled);
  expect(f.compiled[0]).toStartWith("fallback:");
});
