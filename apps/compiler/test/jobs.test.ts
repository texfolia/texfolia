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

test("preview jobs persist PNGs once and expose them through the local API", async () => {
  const root = await mkdtemp(join(tmpdir(), "texfolia-template-preview-"));
  let runs = 0;
  const started = Promise.withResolvers<void>();
  const preview = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const engine = async (
    sources: Parameters<Parameters<typeof createJobs>[0]["engine"]>[0],
  ) => {
    expect("preview" in sources && sources.preview).toBe(true);
    runs++;
    started.resolve();
    return { ...output, preview };
  };
  const open = () =>
    createLocalRuntime({
      path: join(root, "jobs.sqlite"),
      engine,
      projectEngine: () => engine,
    });
  let runtime = open();
  const id = crypto.randomUUID();
  const request = () =>
    new Request("http://local/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Compilation-Id": id },
      body: JSON.stringify({ ...project, preview: true }),
    });
  try {
    const missingPreview = await runtime.fetch(
      new Request(`http://local/compilations/${id}.png`),
    );
    expect(missingPreview.status).toBe(404);
    expect(await missingPreview.json()).toEqual({ error: "PNG not found" });
    expect((await runtime.fetch(request())).status).toBe(202);
    await started.promise;
    await runtime.close();
    runtime = open();
    const image = await runtime.fetch(
      new Request(`http://local/compilations/${id}.png`),
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(preview);
    expect((await runtime.fetch(request())).status).toBe(202);
    expect(runs).toBe(1);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    const missingPdf = await first.fetch(request(artifactUrl));
    expect(missingPdf.status).toBe(404);
    expect(await missingPdf.json()).toEqual({ error: "PDF not found" });
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

test("legacy retention removes terminal, abandoned, and pre-record artifacts in the real local store", async () => {
  const { Database } = await import("bun:sqlite");
  const { legacyRetentionMs } = await import("../src/jobs");
  const root = await mkdtemp(join(tmpdir(), "texfolia-legacy-retention-"));
  const path = join(root, "jobs.sqlite");
  let runs = 0;
  const engine = async () => {
    runs++;
    return output;
  };
  const open = () =>
    createLocalRuntime({ path, engine, projectEngine: () => engine });
  await open().close();
  const db = new Database(path);
  const put = db.query(
    "INSERT INTO objects (key, body, metadata, uploaded) VALUES (?, ?, ?, ?)",
  );
  const expired = Date.now() - legacyRetentionMs - 60_000;
  const pendingId = crypto.randomUUID();
  const freshId = crypto.randomUUID();
  const status = (id: string, at: number) => ({
    id,
    digest: "digest",
    createdAt: new Date(at).toISOString(),
    plan: "pro",
    status: "succeeded",
    log: "log",
    sizeBytes: 3,
    artifactUrl: `/compilations/${id}.pdf`,
  });
  const oldKeys = [];
  for (const state of ["succeeded", "failed"]) {
    const id = crypto.randomUUID();
    const result =
      state === "succeeded"
        ? status(id, expired)
        : {
            ...status(id, expired),
            status: "failed",
            error: "invalid",
            errorStatus: 422,
          };
    const key = `results/${id}.json`;
    oldKeys.push(key);
    put.run(
      key,
      new TextEncoder().encode(JSON.stringify(result)),
      null,
      expired,
    );
    for (const key of [
      `compilations/${id}.pdf`,
      `compilations/${id}.png`,
      `transcripts/${id}`,
      `running/${id}`,
      `sent/${id}`,
      `attempts/${id}/1`,
      `attempts/${id}/2`,
    ]) {
      oldKeys.push(key);
      put.run(key, new Uint8Array([1, 2, 3]), null, expired);
    }
  }
  const sourceKey = `sources/${pendingId}.json`;
  oldKeys.push(
    sourceKey,
    "compilations/pre-job-record.pdf",
    "compilations/interrupted.png",
  );
  put.run(
    sourceKey,
    new TextEncoder().encode(JSON.stringify(project)),
    JSON.stringify({ ...status(pendingId, expired), status: "queued" }),
    expired,
  );
  put.run(
    "compilations/pre-job-record.pdf",
    new Uint8Array([1]),
    null,
    expired,
  );
  put.run("compilations/interrupted.png", new Uint8Array([1]), null, expired);
  put.run(
    `results/${freshId}.json`,
    new TextEncoder().encode(JSON.stringify(status(freshId, Date.now()))),
    null,
    Date.now(),
  );
  put.run(
    `compilations/${freshId}.pdf`,
    new Uint8Array([1, 2, 3]),
    null,
    Date.now(),
  );
  put.run("projects/retained/1/output.pdf", new Uint8Array([1]), null, expired);
  db.query(
    "INSERT INTO deliveries (id, lane, body, due, attempts) VALUES (?, 'compile-pro', ?, 0, 0)",
  ).run(
    crypto.randomUUID(),
    JSON.stringify({ projectId: pendingId, revision: 0 }),
  );
  const runtime = open();
  try {
    const deadline = Date.now() + 5000;
    while (
      oldKeys.some((key) =>
        db.query("SELECT key FROM objects WHERE key = ?").get(key),
      )
    ) {
      if (Date.now() > deadline)
        throw new Error("Legacy recovery did not sweep expired objects");
      await Bun.sleep(25);
    }
    expect(runs).toBe(0);
    expect(
      (await runtime.fetch(new Request(`http://local/jobs/${pendingId}`)))
        .status,
    ).toBe(404);
    expect(
      (await runtime.fetch(new Request(`http://local/jobs/${freshId}`))).status,
    ).toBe(200);
    expect(
      (
        await runtime.fetch(
          new Request(`http://local/compilations/${freshId}.pdf`),
        )
      ).status,
    ).toBe(200);
    expect(
      db
        .query(
          "SELECT key FROM objects WHERE key = 'projects/retained/1/output.pdf'",
        )
        .get(),
    ).not.toBeNull();
  } finally {
    await runtime.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
