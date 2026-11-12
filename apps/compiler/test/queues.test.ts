import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { z } from "zod";

import { ProjectCoordinatorCore } from "../src/coordinator";
import { createCoordinatorApp } from "../src/coordinator-api";
import { createJobs, type Engine, type ObjectStore } from "../src/jobs";
import { createLocalRuntime } from "../src/local";
import { HttpError } from "../src/project";
import {
  backgroundDelay,
  compileQueue,
  createLegacyConsumer,
  deadLetterError,
  processQueueMessage,
  type BackgroundMessage,
  type CompileMessage,
} from "../src/queues";
import { sourceHash, sourceObjectKey } from "../src/source-sync";
import { planSchema, unknownEngineTiming } from "../src/telemetry";

const project = { mainFile: "main.tex", files: { "main.tex": "source" } };
const output = {
  pdf: new TextEncoder().encode("%PDF-test"),
  log: "compiled",
  timing: unknownEngineTiming,
};
const persistedSchema = z
  .object({
    pending: z.object({ due: z.number() }).passthrough().nullable(),
    maintenanceAt: z.number().nullable(),
    lastActivity: z.number(),
  })
  .passthrough();

function harness(engine: Engine) {
  const objects = new Map<
    string,
    { bytes: Uint8Array; metadata?: string; uploaded: number }
  >();
  const store: ObjectStore = {
    async read(key) {
      const object = objects.get(key);
      return object ? new Response(object.bytes).body : null;
    },
    async head(key) {
      const object = objects.get(key);
      return object
        ? { size: object.bytes.length, metadata: object.metadata }
        : null;
    },
    async create(key, value, metadata) {
      if (objects.has(key)) return false;
      objects.set(key, {
        bytes:
          typeof value === "string" ? new TextEncoder().encode(value) : value,
        metadata,
        uploaded: Date.now(),
      });
      return true;
    },
    async write(key, value) {
      objects.set(key, {
        bytes:
          typeof value === "string" ? new TextEncoder().encode(value) : value,
        uploaded: Date.now(),
      });
    },
    async remove(key) {
      objects.delete(key);
    },
    async *keys(prefix, before = Infinity) {
      for (const [key, object] of objects)
        if (key.startsWith(prefix) && object.uploaded < before) yield key;
    },
  };
  const messages: { queue: string; body: CompileMessage }[] = [];
  const background: { body: BackgroundMessage; delaySeconds: number }[] = [];
  const state: {
    saved: string | null;
    sendFails: boolean;
    backgroundFails: boolean;
    onSend: (() => void) | undefined;
  } = {
    saved: null,
    sendFails: false,
    backgroundFails: false,
    onSend: undefined,
  };
  const alarms: number[] = [];
  const options = {
    projectId: crypto.randomUUID(),
    store,
    engine,
    saved: null,
    save(value: string) {
      state.saved = value;
    },
    async schedule(at: number) {
      alarms.push(at);
    },
    async overflow(body: CompileMessage, plan: z.infer<typeof planSchema>) {
      if (state.sendFails) throw new Error("Queue unavailable");
      messages.push({ queue: compileQueue(plan), body });
      state.onSend?.();
    },
    async background(body: BackgroundMessage, delaySeconds: number) {
      if (state.backgroundFails)
        throw new Error("Background queue unavailable");
      background.push({ body, delaySeconds });
    },
  };
  let core = new ProjectCoordinatorCore(options);
  const jobs = createJobs({
    store,
    engine,
    queue: {
      async send({ id }, plan) {
        messages.push({
          queue: compileQueue(plan),
          body: { projectId: id, revision: 0 },
        });
      },
    },
  });
  const legacy = createLegacyConsumer(jobs);
  return {
    get core() {
      return core;
    },
    store,
    objects,
    messages,
    background,
    jobs,
    state,
    alarms,
    projectId: options.projectId,
    async restart(change?: (saved: z.infer<typeof persistedSchema>) => void) {
      await core.close();
      const saved = persistedSchema.parse(JSON.parse(state.saved ?? "null"));
      change?.(saved);
      state.saved = JSON.stringify(saved);
      core = new ProjectCoordinatorCore({
        ...options,
        saved: state.saved,
      });
    },
    async submit(plan = "free") {
      const response = await createCoordinatorApp(core).fetch(
        new Request(`http://local/projects/${options.projectId}/compile`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Compile-Plan": plan,
          },
          body: JSON.stringify(project),
        }),
      );
      expect(response.status).toBe(202);
      await this.restart((saved) => {
        if (saved.pending) saved.pending.due = 0;
      });
    },
    deliver(queue: string, body: unknown, attempts = 1) {
      return processQueueMessage({
        queue,
        body,
        attempts,
        jobs,
        legacy,
        coordinator: () => core,
      });
    },
  };
}

test("compile consumers have independent priority, one retry, and a shared DLQ; background batches separately", async () => {
  const parsed: unknown = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ).config;
  const config = z
    .object({
      queues: z.object({
        producers: z.array(
          z.object({ binding: z.string(), queue: z.string() }),
        ),
        consumers: z.array(
          z.object({
            queue: z.string(),
            max_retries: z.number().optional(),
            dead_letter_queue: z.string().optional(),
            max_concurrency: z.number(),
            max_batch_size: z.number(),
          }),
        ),
      }),
    })
    .parse(parsed);
  for (const name of ["compile-pro", "compile-free"]) {
    expect(
      config.queues.consumers.find((consumer) => consumer.queue === name),
    ).toMatchObject({
      max_retries: 1,
      dead_letter_queue: "compile-dlq",
      max_batch_size: 1,
    });
    expect(
      config.queues.producers.some((producer) => producer.queue === name),
    ).toBe(true);
  }
  expect(
    config.queues.consumers.find((consumer) => consumer.queue === "compile-pro")
      ?.max_concurrency,
  ).toBeGreaterThan(
    config.queues.consumers.find(
      (consumer) => consumer.queue === "compile-free",
    )?.max_concurrency ?? Infinity,
  );
  expect(
    config.queues.consumers.find((consumer) => consumer.queue === "background")
      ?.max_batch_size,
  ).toBeGreaterThan(1);
  expect(
    config.queues.consumers.some(
      (consumer) => consumer.queue === "compile-dlq",
    ),
  ).toBe(true);
  expect(
    config.queues.producers.some((producer) => producer.queue === "background"),
  ).toBe(true);
  expect(config.queues.consumers).toHaveLength(4);
});

test("interactive success stays direct; X-Compile-Plan selects only the overflow lane", async () => {
  for (const plan of ["pro", "free", "unknown", "invalid"]) {
    let runs = 0;
    const fixture = harness(async () => {
      runs++;
      return output;
    });
    try {
      await fixture.submit(plan);
      await fixture.core.wake();
      expect(runs).toBe(1);
      expect(fixture.messages).toEqual([]);
      expect(fixture.core.snapshot().current?.status).toBe("succeeded");
      expect(fixture.background[0]?.delaySeconds).toBeGreaterThan(0);
    } finally {
      await fixture.core.close();
    }
    const failing = harness(async () => {
      throw new Error("Container unavailable");
    });
    try {
      await failing.submit(plan);
      await failing.core.wake();
      expect(failing.messages).toEqual([
        {
          queue: plan === "pro" ? "compile-pro" : "compile-free",
          body: { projectId: failing.projectId, revision: 1 },
        },
      ]);
    } finally {
      await failing.core.close();
    }
  }
});

test("overflow fails once, retries once, then DLQ persists and publishes a terminal failure across restarts", async () => {
  let runs = 0;
  const fixture = harness(async () => {
    runs++;
    throw new Error("Container unavailable");
  });
  try {
    await fixture.submit("pro");
    await fixture.core.wake();
    await fixture.core.wake();
    expect(runs).toBe(1);
    expect(fixture.messages).toHaveLength(1);
    const body = fixture.messages[0]!.body;
    expect(await fixture.deliver("compile-pro", body, 1)).toBe(false);
    await fixture.restart();
    await fixture.core.wake();
    expect(runs).toBe(2);
    expect(await fixture.deliver("compile-pro", body, 2)).toBe(false);
    expect(runs).toBe(3);
    expect(fixture.core.snapshot().current?.status).toBe("queued");
    expect(await fixture.deliver("compile-pro", body, 3)).toBe(false);
    expect(runs).toBe(3);
    const stream = fixture.core
      .events(new AbortController().signal)
      .body!.getReader();
    await stream.read();
    expect(await fixture.deliver("compile-dlq", body)).toBe(true);
    expect(new TextDecoder().decode((await stream.read()).value)).toContain(
      deadLetterError,
    );
    await stream.cancel();
    expect(fixture.core.snapshot().current).toMatchObject({
      status: "failed",
      error: deadLetterError,
    });
    const id = fixture.core.snapshot().current!.id;
    await fixture.restart();
    expect(await fixture.core.get(id)).toMatchObject({
      status: "failed",
      error: deadLetterError,
    });
    expect(await fixture.deliver("compile-dlq", body, 2)).toBe(true);
    expect(await fixture.deliver("compile-pro", body, 2)).toBe(true);
    expect(runs).toBe(3);
  } finally {
    await fixture.core.close();
  }
});

test("the one queued retry can succeed and duplicate delivery does not run TeX again", async () => {
  let runs = 0;
  const fixture = harness(async () => {
    if (++runs < 3) throw new Error("Temporary outage");
    return output;
  });
  try {
    await fixture.submit();
    await fixture.core.wake();
    const body = fixture.messages[0]!.body;
    expect(await fixture.deliver("compile-free", body, 1)).toBe(false);
    expect(await fixture.deliver("compile-free", body, 2)).toBe(true);
    expect(fixture.core.snapshot().current).toMatchObject({
      status: "succeeded",
      timing: { attempt: 3 },
    });
    expect(await fixture.deliver("compile-free", body, 2)).toBe(true);
    expect(runs).toBe(3);
  } finally {
    await fixture.core.close();
  }
});

test("queue delivery during direct handoff waits for the direct run without wasting a queue attempt", async () => {
  let runs = 0;
  const fixture = harness(async () => {
    if (++runs === 1) throw new Error("Direct container failure");
    return output;
  });
  const consumed = Promise.withResolvers<boolean>();
  try {
    await fixture.submit("pro");
    fixture.state.onSend = () => {
      const message = fixture.messages[0]!;
      void fixture
        .deliver(message.queue, message.body)
        .then(consumed.resolve, consumed.reject);
    };
    await fixture.core.wake();
    expect(await consumed.promise).toBe(true);
    expect(runs).toBe(2);
    expect(fixture.core.snapshot().current?.status).toBe("succeeded");
  } finally {
    await fixture.core.close();
  }
});

test("only malformed message envelopes are acknowledged; corrupt stored jobs remain retryable", async () => {
  const fixture = harness(async () => output);
  try {
    expect(
      await fixture.deliver("compile-free", { projectId: "invalid" }),
    ).toBe(true);
    expect(await fixture.deliver("compile-dlq", {})).toBe(true);
    expect(await fixture.deliver("background", { kind: "invalid" })).toBe(true);
    const id = crypto.randomUUID();
    await fixture.jobs.submit(id, project);
    const source = fixture.objects.get(`sources/${id}.json`);
    if (!source) throw new Error("Missing persisted source");
    source.metadata = "{}";
    await expect(
      fixture.deliver("compile-free", { projectId: id, revision: 0 }),
    ).rejects.toBeInstanceOf(z.ZodError);
  } finally {
    await fixture.core.close();
  }
});

test("DLQ storage failures are retryable and the failed revision stays pending until recorded", async () => {
  const fixture = harness(async () => {
    throw new Error("Container unavailable");
  });
  try {
    await fixture.submit();
    await fixture.core.wake();
    const body = fixture.messages[0]!.body;
    const write = fixture.store.write.bind(fixture.store);
    fixture.store.write = async () => {
      throw new Error("R2 unavailable");
    };
    await expect(fixture.deliver("compile-dlq", body)).rejects.toThrow(
      "R2 unavailable",
    );
    expect(fixture.core.snapshot().current?.status).toBe("queued");
    fixture.store.write = write;
    expect(await fixture.deliver("compile-dlq", body, 2)).toBe(true);
    expect(fixture.core.snapshot().current).toMatchObject({
      status: "failed",
      error: deadLetterError,
    });
  } finally {
    await fixture.core.close();
  }
});

test("late overflow and DLQ messages cannot fail or compile a newer revision", async () => {
  let runs = 0;
  const fixture = harness(async () => {
    if (++runs === 1) throw new Error("Overflow");
    return output;
  });
  try {
    await fixture.submit();
    await fixture.core.wake();
    const old = fixture.messages[0]!.body;
    await fixture.submit("pro");
    expect(await fixture.deliver("compile-free", old)).toBe(true);
    expect(await fixture.deliver("compile-dlq", old)).toBe(true);
    expect(fixture.core.snapshot().current).toMatchObject({
      revision: 2,
      status: "queued",
    });
    await fixture.core.wake();
    expect(await fixture.deliver("compile-dlq", old)).toBe(true);
    expect(fixture.core.snapshot().current).toMatchObject({
      revision: 2,
      status: "succeeded",
    });
    expect(runs).toBe(2);
  } finally {
    await fixture.core.close();
  }
});

test("a failed queue send is recovered by an alarm without rerunning the direct compile", async () => {
  let runs = 0;
  const fixture = harness(async () => {
    runs++;
    throw new Error("Overflow");
  });
  try {
    await fixture.submit();
    fixture.state.sendFails = true;
    await expect(fixture.core.wake()).rejects.toThrow("Queue unavailable");
    await fixture.restart();
    fixture.state.sendFails = false;
    await fixture.core.wake();
    await fixture.core.wake();
    expect(runs).toBe(1);
    expect(fixture.messages).toHaveLength(1);
  } finally {
    await fixture.core.close();
  }
});

test("TeX errors are terminal without pointless infrastructure retries", async () => {
  const fixture = harness(async () => {
    throw new HttpError(422, "Invalid TeX", "error log");
  });
  try {
    await fixture.submit();
    await fixture.core.wake();
    expect(fixture.messages).toEqual([]);
    expect(fixture.core.snapshot().current).toMatchObject({
      status: "failed",
      error: "Invalid TeX",
      log: "error log",
    });
  } finally {
    await fixture.core.close();
  }
});

test("legacy jobs use compact plan-routed messages and DLQ failure cannot be resurrected by recovery", async () => {
  let runs = 0;
  const fixture = harness(async () => {
    runs++;
    throw new Error("Engine unavailable");
  });
  try {
    const id = crypto.randomUUID();
    await fixture.jobs.submit(id, project, "pro");
    const body = { projectId: id, revision: 0 };
    expect(fixture.messages).toEqual([{ queue: "compile-pro", body }]);
    expect(await fixture.deliver("compile-pro", body, 1)).toBe(false);
    expect(await fixture.deliver("compile-pro", body, 2)).toBe(false);
    expect(await fixture.deliver("compile-pro", body, 1)).toBe(false);
    expect(runs).toBe(2);
    expect(await fixture.deliver("compile-dlq", body)).toBe(true);
    expect(await fixture.jobs.get(id)).toMatchObject({
      status: "failed",
      error: deadLetterError,
    });
    await fixture.jobs.recover();
    expect(await fixture.deliver("compile-pro", body)).toBe(true);
    expect(runs).toBe(2);
    expect(
      [...fixture.objects.keys()].some((key) => key.startsWith("attempts/")),
    ).toBe(false);
  } finally {
    await fixture.core.close();
  }
});

test("concurrent legacy redeliveries share one compile and DLQ cannot beat a successful active compile", async () => {
  let runs = 0;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = harness(async () => {
    runs++;
    started.resolve();
    await release.promise;
    return output;
  });
  try {
    const id = crypto.randomUUID();
    await fixture.jobs.submit(id, project, "pro");
    const body = { projectId: id, revision: 0 };
    const first = fixture.deliver("compile-pro", body);
    await started.promise;
    const duplicate = fixture.deliver("compile-pro", body);
    const deadLetter = fixture.deliver("compile-dlq", body);
    release.resolve();
    expect(await first).toBe(true);
    expect(await duplicate).toBe(true);
    expect(await deadLetter).toBe(true);
    expect(runs).toBe(1);
    expect(await fixture.jobs.get(id)).toMatchObject({ status: "succeeded" });
  } finally {
    release.resolve();
    await fixture.core.close();
  }
});

test("maintenance is delayed, capped to daily hops, and a paused sweep does not hold interactive submissions", async () => {
  const fixture = harness(async () => output);
  const listing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await fixture.submit();
    await fixture.core.wake();
    await fixture.restart((saved) => {
      saved.maintenanceAt = Date.now() - 1;
    });
    const at = persistedSchema.parse(
      JSON.parse(fixture.state.saved!),
    ).maintenanceAt!;
    const originalKeys = fixture.store.keys.bind(fixture.store);
    fixture.store.keys = async function* (prefix, before) {
      if (prefix.endsWith("/builds/")) {
        listing.resolve();
        await release.promise;
      }
      yield* originalKeys(prefix, before);
    };
    const work = fixture.deliver("background", {
      kind: "maintenance",
      projectId: fixture.projectId,
      at,
    });
    await listing.promise;
    const submit = createCoordinatorApp(fixture.core).fetch(
      new Request(`http://local/projects/${fixture.projectId}/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      }),
    );
    const accepted = await Promise.race([
      submit,
      Bun.sleep(500).then(() => null),
    ]);
    expect(accepted?.status).toBe(202);
    release.resolve();
    expect(await work).toBe(true);
    expect(fixture.core.snapshot().current).toMatchObject({
      revision: 2,
      status: "queued",
    });
    expect(backgroundDelay(Date.now() + 30 * 24 * 60 * 60_000)).toBe(86_400);
    expect(backgroundDelay(Date.now() - 1000)).toBe(0);
  } finally {
    release.resolve();
    await fixture.core.close();
  }
});

for (const reuse of [false, true])
  test(
    reuse
      ? "a delta reusing a deleting source waits for that object and recreates it safely"
      : "source-object cleanup does not hold the writer or block unrelated interactive compiles",
    async () => {
      const fixture = harness(async (project, context) => {
        if ("kind" in project)
          expect(await context.readSource?.(project.files["main.tex"]!)).toBe(
            "reused",
          );
        return output;
      });
      const removing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let cleanup: Promise<boolean> | undefined;
      try {
        await fixture.submit();
        await fixture.core.wake();
        const hash = await sourceHash(new TextEncoder().encode("reused"));
        const key = sourceObjectKey(fixture.projectId, hash);
        fixture.objects.set(key, {
          bytes: new TextEncoder().encode("reused"),
          uploaded: 0,
        });
        await fixture.restart((saved) => {
          saved.maintenanceAt = Date.now() - 1;
        });
        const at = persistedSchema.parse(
          JSON.parse(fixture.state.saved!),
        ).maintenanceAt!;
        const remove = fixture.store.remove.bind(fixture.store);
        fixture.store.remove = async (candidate) => {
          if (candidate === key) {
            removing.resolve();
            await release.promise;
          }
          await remove(candidate);
        };
        cleanup = fixture.deliver("background", {
          kind: "maintenance",
          projectId: fixture.projectId,
          at,
        });
        await removing.promise;
        const body = reuse
          ? {
              mainFile: "main.tex",
              baseRevision: 0,
              revision: 1,
              resync: true,
              files: { "main.tex": { hash, content: "reused" } },
              deleted: [],
            }
          : project;
        const submitted = Promise.resolve(
          createCoordinatorApp(fixture.core).fetch(
            new Request(`http://local/projects/${fixture.projectId}/compile`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
          ),
        );
        if (reuse) {
          expect(
            await Promise.race([
              submitted.then(() => "accepted"),
              Bun.sleep(20).then(() => "waiting"),
            ]),
          ).toBe("waiting");
          release.resolve();
          expect((await submitted).status).toBe(202);
        } else {
          expect(
            (await Promise.race([submitted, Bun.sleep(500).then(() => null)]))
              ?.status,
          ).toBe(202);
          expect(fixture.core.snapshot().current).toMatchObject({
            revision: 2,
            status: "queued",
          });
          release.resolve();
        }
        expect(await cleanup).toBe(true);
        if (reuse)
          expect(
            new TextDecoder().decode(fixture.objects.get(key)?.bytes),
          ).toBe("reused");
        await fixture.restart((saved) => {
          if (saved.pending) saved.pending.due = 0;
        });
        await fixture.core.wake();
        expect(fixture.core.snapshot().current?.status).toBe("succeeded");
      } finally {
        release.resolve();
        await cleanup?.catch(() => {});
        await fixture.core.close();
      }
    },
  );

test("local Pro queue and interactive path progress while a Free consumer is blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "priority-queues-"));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const runtime = createLocalRuntime({
    path: join(root, "state.sqlite"),
    engine: async (_project, context) => {
      if (context.plan === "free") {
        started.resolve();
        await release.promise;
      }
      return output;
    },
    projectEngine: () => async () => output,
  });
  const request = (path: string, plan: string, id: string) =>
    new Request(`http://local${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Compile-Plan": plan,
        "X-Compilation-Id": id,
      },
      body: JSON.stringify(project),
    });
  try {
    await runtime.fetch(request("/compile", "free", crypto.randomUUID()));
    await started.promise;
    const proId = crypto.randomUUID();
    await runtime.fetch(request("/compile", "pro", proId));
    const projectId = crypto.randomUUID();
    const interactiveId = crypto.randomUUID();
    await runtime.fetch(
      request(`/projects/${projectId}/compile`, "pro", interactiveId),
    );
    const database = new Database(join(root, "state.sqlite"), {
      readonly: true,
    });
    try {
      const deadline = Date.now() + 2000;
      while (
        Date.now() < deadline &&
        !database
          .query("SELECT key FROM objects WHERE key = ?")
          .get(`results/${proId}.json`)
      )
        await Bun.sleep(10);
      expect(
        await (
          await runtime.fetch(new Request(`http://local/jobs/${proId}`))
        ).json(),
      ).toMatchObject({ status: "succeeded" });
      while (
        Date.now() < deadline &&
        !database
          .query("SELECT key FROM objects WHERE key = ?")
          .get(`projects/${projectId}/results/${interactiveId}.json`)
      )
        await Bun.sleep(10);
      expect(
        await (
          await runtime.fetch(new Request(`http://local/projects/${projectId}`))
        ).json(),
      ).toMatchObject({ current: { status: "succeeded" } });
    } finally {
      database.close();
    }
  } finally {
    release.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite delivery retries once and routes the failed interactive job through DLQ", async () => {
  const root = await mkdtemp(join(tmpdir(), "compile-dlq-"));
  const path = join(root, "state.sqlite");
  let runs = 0;
  const runtime = createLocalRuntime({
    path,
    engine: async () => output,
    projectEngine: () => async () => {
      runs++;
      throw new Error("Container unavailable");
    },
  });
  const projectId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const database = new Database(path);
  try {
    expect(
      (
        await runtime.fetch(
          new Request(`http://local/projects/${projectId}/compile`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Compilation-Id": id,
              "X-Compile-Plan": "pro",
            },
            body: JSON.stringify(project),
          }),
        )
      ).status,
    ).toBe(202);
    const retry = database.query<{ attempts: number }, []>(
      "SELECT attempts FROM deliveries WHERE lane = 'compile-pro'",
    );
    const result = database.query<{ body: Uint8Array }, [string]>(
      "SELECT body FROM objects WHERE key = ?",
    );
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && retry.get()?.attempts !== 1)
      await Bun.sleep(10);
    expect(retry.get()?.attempts).toBe(1);
    expect(runs).toBe(2);
    database.exec("UPDATE deliveries SET due = 0 WHERE lane = 'compile-pro'");
    while (
      Date.now() < deadline &&
      !result.get(`projects/${projectId}/results/${id}.json`)
    )
      await Bun.sleep(10);
    expect(
      await (
        await runtime.fetch(new Request(`http://local/projects/${projectId}`))
      ).json(),
    ).toMatchObject({ current: { status: "failed", error: deadLetterError } });
    expect(runs).toBe(3);
    expect(
      database
        .query(
          "SELECT id FROM deliveries WHERE lane IN ('compile-pro', 'compile-dlq')",
        )
        .all(),
    ).toHaveLength(0);
  } finally {
    database.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("retention messages hop without sweeping early and failed background sends leave a durable alarm fallback", async () => {
  const fixture = harness(async () => output);
  try {
    await fixture.submit();
    await fixture.core.wake();
    const deadline = Date.now() + 30 * 24 * 60 * 60_000;
    await fixture.restart((saved) => {
      saved.maintenanceAt = deadline;
    });
    const count = fixture.objects.size;
    const sent = fixture.background.length;
    expect(
      await fixture.deliver("background", {
        kind: "maintenance",
        projectId: fixture.projectId,
        at: deadline,
      }),
    ).toBe(true);
    expect(fixture.objects.size).toBe(count);
    expect(fixture.background).toHaveLength(sent + 1);
    expect(fixture.background.at(-1)).toMatchObject({
      body: { at: deadline },
      delaySeconds: 86_400,
    });
    const originalKeys = fixture.store.keys.bind(fixture.store);
    let listed = false;
    fixture.store.keys = async function* (prefix, before) {
      listed = true;
      yield* originalKeys(prefix, before);
    };
    expect(
      await fixture.deliver("background", {
        kind: "maintenance",
        projectId: fixture.projectId,
        at: deadline - 1,
      }),
    ).toBe(true);
    expect(listed).toBe(false);
  } finally {
    await fixture.core.close();
  }
  const blocked = harness(async () => output);
  try {
    await blocked.submit();
    blocked.state.backgroundFails = true;
    await blocked.core.wake();
    expect(blocked.core.snapshot().current?.status).toBe("succeeded");
    expect(blocked.background).toEqual([]);
    expect(blocked.alarms.at(-1)).toBeGreaterThan(Date.now());
    await blocked.restart();
    blocked.state.backgroundFails = false;
    await blocked.core.wake();
    expect(blocked.background).toHaveLength(1);
  } finally {
    await blocked.core.close();
  }
});

test("an overdue maintenance alarm only re-enqueues background work; empty coordinators stay idle", async () => {
  const fixture = harness(async () => output);
  try {
    await fixture.core.wake();
    expect(fixture.background).toEqual([]);
    expect(fixture.alarms).toEqual([]);
    await fixture.submit();
    await fixture.core.wake();
    await fixture.restart((saved) => {
      saved.maintenanceAt = Date.now() - 60_000;
    });
    const count = fixture.objects.size;
    const sent = fixture.background.length;
    await fixture.core.wake();
    expect(fixture.background).toHaveLength(sent + 1);
    expect(fixture.background.at(-1)?.delaySeconds).toBeGreaterThan(0);
    expect(fixture.objects.size).toBe(count);
    expect(fixture.core.snapshot().current?.status).toBe("succeeded");
  } finally {
    await fixture.core.close();
  }
});
