import { expect, test } from "bun:test";

import { z } from "zod";

import { ProjectCoordinatorCore } from "../src/coordinator";
import type { ObjectStore } from "../src/jobs";
import { createProjectEngineClient } from "../src/project-engine";
import { sourceHash, type SyncedProject } from "../src/source-sync";
import { unknownEngineTiming } from "../src/telemetry";

function fixture() {
  const projectId = crypto.randomUUID();
  const objects = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const paths: string[] = [];
  let boot = 1;
  let cacheReady = false;
  let invalid = false;
  let healthFails = false;
  let restoreGate = Promise.resolve();
  const store: ObjectStore = {
    async read(key) {
      reads.push(key);
      const value = objects.get(key);
      return value ? new Response(value).body : null;
    },
    async head(key) {
      const value = objects.get(key);
      return value ? { size: value.byteLength } : null;
    },
    async create(key, value) {
      if (objects.has(key)) return false;
      objects.set(
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
      return true;
    },
    async write(key, value) {
      objects.set(
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
    },
    async remove(key) {
      objects.delete(key);
    },
    async *keys(prefix) {
      for (const key of objects.keys()) if (key.startsWith(prefix)) yield key;
    },
  };
  const engine = createProjectEngineClient({
    projectId,
    store,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/health") {
        if (healthFails) throw new Error("Container could not start");
        return Response.json({
          bootId: String(boot),
          cacheReady,
          bootMs: 4,
          imageSizeBytes: 250_000_000,
        });
      }
      expect(request.headers.get("X-Project-Id")).toBe(projectId);
      if (path === "/cache") {
        await restoreGate;
        if (invalid && request.headers.get("X-Cache-Missing") !== "1")
          return Response.json({ error: "Invalid archive" }, { status: 422 });
        cacheReady = true;
        return Response.json({ archiveUnpackMs: 2 });
      }
      expect(path).toBe("/compile");
      const input = z
        .object({ revision: z.number().optional() })
        .parse(await request.json());
      const form = new FormData();
      form.set("pdf", new Blob(["%PDF-real-output"]), "main.pdf");
      form.set("log", "compiled");
      form.set("cache", new Blob(["next archive"]), "cache.tar.zst");
      return new Response(form, {
        headers: {
          "X-Compile-Timing": JSON.stringify({
            ...unknownEngineTiming,
            engine: "tectonic",
            cacheUsed: request.headers.get("X-Clean-Compile") !== "1",
          }),
          "X-Source-Revision": String(input.revision ?? 0),
        },
      });
    },
  });
  const archiveKey = `projects/${projectId}/cache.tar.zst`;
  objects.set(archiveKey, new TextEncoder().encode("archive"));
  const context = () => ({
    projectId,
    jobId: crypto.randomUUID(),
    plan: "free" as const,
    attempt: 1,
  });
  const project = { mainFile: "main.tex", files: { "main.tex": "source" } };
  return {
    projectId,
    store,
    engine,
    paths,
    reads,
    objects,
    archiveKey,
    context,
    project,
    restart() {
      boot++;
      cacheReady = false;
    },
    corrupt() {
      invalid = true;
    },
    failHealth(value: boolean) {
      healthFails = value;
    },
    gateRestore(gate: Promise<void>) {
      restoreGate = gate;
    },
  };
}

test("SSE attach prewarms without blocking snapshots; compile shares restore and downloads sources in parallel", async () => {
  const runtime = fixture();
  const downloaded = Promise.withResolvers<void>();
  runtime.gateRestore(downloaded.promise);
  const background: Promise<void>[] = [];
  const core = new ProjectCoordinatorCore({
    projectId: runtime.projectId,
    saved: null,
    save() {},
    schedule: async () => {},
    overflow: async () => {},
    store: runtime.store,
    engine: runtime.engine,
    waitUntil: (promise) => background.push(promise),
  });
  const events = core.events(new AbortController().signal);
  expect(background).toHaveLength(1);
  const reader = events.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    '"revision":0',
  );
  const content = "source";
  const source: SyncedProject = {
    kind: "synced",
    mainFile: "main.tex",
    revision: 1,
    files: {
      "main.tex": {
        hash: await sourceHash(new TextEncoder().encode(content)),
        encoding: "text",
        size: content.length,
      },
    },
  };
  try {
    const output = await runtime.engine(source, {
      ...runtime.context(),
      readSource: async () => {
        downloaded.resolve();
        return content;
      },
    });
    await Promise.all(background);
    expect(runtime.paths.filter((path) => path === "/cache")).toHaveLength(1);
    expect(runtime.reads).toEqual([runtime.archiveKey]);
    expect(output.timing).toMatchObject({
      archiveStatus: "restored",
      archiveBytes: 7,
      archiveUnpackMs: 2,
      bootMs: 4,
      imageSizeBytes: 250_000_000,
      prewarmed: true,
    });
    expect(await output.cacheArchive?.text()).toBe("next archive");
  } finally {
    downloaded.resolve();
    await reader.cancel();
    await core.close();
  }
});

test("warm requests never fetch cache files; a restarted container restores exactly one archive", async () => {
  const runtime = fixture();
  await runtime.engine.prewarm?.();
  const first = await runtime.engine(runtime.project, runtime.context());
  expect(first.timing.prewarmed).toBe(true);
  const warm = await runtime.engine(runtime.project, runtime.context());
  expect(warm.timing.archiveStatus).toBe("warm");
  expect(runtime.reads).toEqual([runtime.archiveKey]);
  runtime.restart();
  const cold = await runtime.engine(runtime.project, runtime.context());
  expect(cold.timing.archiveStatus).toBe("restored");
  expect(cold.timing.prewarmed).toBe(false);
  expect(runtime.reads).toEqual([runtime.archiveKey, runtime.archiveKey]);
});

test("missing/corrupt cache degrades to clean startup, and failed prewarm can be retried", async () => {
  for (const mode of ["missing", "invalid"] as const) {
    const runtime = fixture();
    if (mode === "missing") runtime.objects.clear();
    else runtime.corrupt();
    await runtime.engine.prewarm?.();
    const output = await runtime.engine(runtime.project, runtime.context());
    expect(output.timing.archiveStatus).toBe(mode);
    expect(runtime.reads).toHaveLength(1);
    expect(runtime.paths.filter((path) => path === "/cache")).toHaveLength(
      mode === "invalid" ? 2 : 1,
    );
  }
  const runtime = fixture();
  runtime.failHealth(true);
  await expect(runtime.engine.prewarm?.()).rejects.toThrow(
    "Container could not start",
  );
  runtime.failHealth(false);
  expect(
    (await runtime.engine(runtime.project, runtime.context())).timing
      .archiveStatus,
  ).toBe("restored");
});

test("expired prewarm telemetry is not attributed to a different boot", async () => {
  const runtime = fixture();
  await runtime.engine.prewarm?.();
  runtime.restart();
  const result = await runtime.engine(runtime.project, runtime.context());
  expect(result.timing).toMatchObject({
    containerBootId: "2",
    prewarmed: false,
    archiveStatus: "restored",
  });
});

test("a failed compile preparation is retryable without unhandled background rejections", async () => {
  const runtime = fixture();
  runtime.failHealth(true);
  await expect(
    runtime.engine(runtime.project, runtime.context()),
  ).rejects.toThrow("Container could not start");
  runtime.failHealth(false);
  expect(
    (await runtime.engine(runtime.project, runtime.context())).timing
      .archiveStatus,
  ).toBe("restored");
});

test("an archive write failure keeps the last published PDF and manifest", async () => {
  const runtime = fixture();
  let fail = false;
  const write = runtime.store.write;
  runtime.store.write = async (key, value) => {
    if (fail && key.endsWith("cache.tar.zst"))
      throw new Error("R2 unavailable");
    await write(key, value);
  };
  const core = new ProjectCoordinatorCore({
    projectId: runtime.projectId,
    saved: null,
    save() {},
    schedule: async () => {},
    overflow: async () => {},
    store: runtime.store,
    engine: runtime.engine,
  });
  try {
    await core.submit(crypto.randomUUID(), runtime.project, "free");
    await Bun.sleep(310);
    await core.wake();
    const first = core.snapshot();
    expect(first.current?.status).toBe("succeeded");
    fail = true;
    await core.submit(crypto.randomUUID(), runtime.project, "free");
    await Bun.sleep(310);
    await core.wake();
    const second = core.snapshot();
    expect(second.current?.status).toBe("failed");
    expect(second.artifacts).toEqual(first.artifacts);
    expect(second.latestBuild).toEqual(first.latestBuild);
    expect(
      new TextDecoder().decode(runtime.objects.get(runtime.archiveKey)),
    ).toBe("next archive");
  } finally {
    await core.close();
  }
});
