import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJobs, type ObjectStore } from "../src/jobs";
import { createLocalRuntime } from "../src/local";
import { HttpError } from "../src/project";
import { unknownEngineTiming } from "../src/telemetry";

const project = { mainFile: "main.tex", files: { "main.tex": "source" } };
const output = {
  pdf: new TextEncoder().encode("%PDF-1.5"),
  log: "TeX transcript",
  timing: {
    ...unknownEngineTiming,
    engine: "tectonic" as const,
    temperature: "warm" as const,
    inputPrepMs: 2,
    compileMs: 5,
    outputMs: 1,
  },
};

test("local API accepts jobs without a token and retains results across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "texfolia-compiler-"));
  const path = join(root, "jobs.sqlite");
  const engineStarted = Promise.withResolvers<void>();
  const finishEngine = Promise.withResolvers<void>();
  let runs = 0;
  const engine = async () => {
    runs++;
    engineStarted.resolve();
    await finishEngine.promise;
    return output;
  };
  const first = createLocalRuntime({
    path,
    engine,
    projectEngine: () => engine,
  });
  const id = crypto.randomUUID();
  const statusUrl = `/jobs/${id}`;
  const artifactUrl = `/compilations/${id}.pdf`;
  const request = (path: string, init?: RequestInit) =>
    new Request(`http://local${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Compilation-Id": id,
      },
    });
  const submit = () =>
    request("/compile", { method: "POST", body: JSON.stringify(project) });
  try {
    expect((await first.fetch(new Request("http://local/health"))).status).toBe(
      200,
    );
    expect((await first.fetch(submit())).status).toBe(202);
    await engineStarted.promise;
    expect(await (await first.fetch(request(statusUrl))).json()).toMatchObject({
      status: "running",
    });
    expect((await first.fetch(request(artifactUrl))).status).toBe(404);
    expect((await first.fetch(submit())).status).toBe(202);
    for (let i = 0; i < 8; i++)
      expect((await first.fetch(submit())).status).toBe(202);
    const limited = await first.fetch(submit());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect((await first.fetch(request(statusUrl))).status).toBe(200);
  } finally {
    finishEngine.resolve();
    await first.close();
  }
  const restarted = createLocalRuntime({
    path,
    engine,
    projectEngine: () => engine,
  });
  try {
    const state = await restarted.fetch(request(statusUrl));
    expect(await state.json()).toMatchObject({
      status: "succeeded",
      artifactUrl,
      log: output.log,
      sizeBytes: output.pdf.length,
    });
    expect(await (await restarted.fetch(request(artifactUrl))).text()).toBe(
      "%PDF-1.5",
    );
    expect((await restarted.fetch(submit())).status).toBe(202);
    const conflict = request("/compile", {
      method: "POST",
      body: JSON.stringify({ files: { "main.tex": "different" } }),
    });
    expect((await restarted.fetch(conflict)).status).toBe(409);
    expect(runs).toBe(1);
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("redelivery after an interrupted result write recovers the matching PDF and log", async () => {
  const id = crypto.randomUUID();
  const data = new Map<string, { body: Uint8Array; metadata?: string }>();
  const bytes = (value: string | Uint8Array) =>
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let interrupt = true;
  const store: ObjectStore = {
    async read(key) {
      const row = data.get(key);
      return row ? new Response(new Uint8Array(row.body)).body : null;
    },
    async head(key) {
      const row = data.get(key);
      return row ? { size: row.body.byteLength, metadata: row.metadata } : null;
    },
    async create(key, value, metadata) {
      if (interrupt && key.startsWith("results/")) {
        interrupt = false;
        throw new Error("Interrupted before committing result");
      }
      if (data.has(key)) return false;
      data.set(key, { body: bytes(value), metadata });
      return true;
    },
    async write(key, value) {
      data.set(key, { body: bytes(value) });
    },
    async remove(key) {
      data.delete(key);
    },
    async *keys(prefix) {
      for (const key of data.keys()) if (key.startsWith(prefix)) yield key;
    },
  };
  const messages: { id: string }[] = [];
  let runs = 0;
  const jobs = createJobs({
    store,
    queue: {
      async send(message) {
        messages.push(message);
      },
    },
    engine: async (_project, context) => {
      expect(context).toEqual({ jobId: id, attempt: 1, plan: "pro" });
      runs++;
      return output;
    },
  });
  await jobs.submit(id, project, "pro");
  expect(messages).toEqual([{ id }]);
  await expect(jobs.consume(id, 1)).rejects.toThrow("Interrupted");
  expect(await jobs.artifact(id)).toBeNull();
  expect(await jobs.consume(id, 2)).toBe(true);
  expect(await jobs.consume(id, 3)).toBe(true);
  expect(await new Response(await jobs.artifact(id)).text()).toBe("%PDF-1.5");
  expect(await jobs.get(id)).toMatchObject({
    status: "succeeded",
    log: output.log,
    plan: "pro",
    timing: {
      engine: "tectonic",
      temperature: "warm",
      compileMs: 5,
      plan: "pro",
      artifactReused: true,
      attempt: 2,
    },
  });
  expect(runs).toBe(1);

  const failed = crypto.randomUUID();
  const failingJobs = createJobs({
    store,
    queue: { async send() {} },
    engine: async () => {
      throw new HttpError(
        422,
        "Invalid LaTeX",
        "TeX error at line 1",
        output.timing,
      );
    },
  });
  await failingJobs.submit(failed, project);
  expect(await failingJobs.consume(failed, 1)).toBe(true);
  expect(await failingJobs.get(failed)).toMatchObject({
    status: "failed",
    errorStatus: 422,
    log: "TeX error at line 1",
    timing: {
      engine: "tectonic",
      temperature: "warm",
      compileMs: 5,
      artifactReused: false,
    },
  });
  expect(await failingJobs.artifact(failed)).toBeNull();

  const retryId = crypto.randomUUID();
  let retryRuns = 0;
  const retryJobs = createJobs({
    store,
    queue: { async send() {} },
    engine: async () => {
      if (++retryRuns === 1) throw new Error("Temporary engine outage");
      return output;
    },
  });
  await retryJobs.submit(retryId, project, "free");
  expect(await retryJobs.consume(retryId, 1)).toBe(false);
  const firstWait = JSON.parse(
    data.get(`running/${retryId}`)?.metadata ?? "null",
  ).queueWaitMs;
  await Bun.sleep(10);
  expect(await retryJobs.consume(retryId, 2)).toBe(true);
  const retried = await retryJobs.get(retryId);
  expect(retried?.timing?.queueWaitMs).toBe(firstWait);
  expect(retried?.timing?.backendMs).toBeGreaterThan(firstWait);
  expect(retried?.timing?.attempt).toBe(2);
});
