import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type ApiBindings, createApp } from "./api";
import { ProjectCoordinatorCore } from "./coordinator";
import { createCoordinatorApp } from "./coordinator-api";
import { createJobs, type Engine, type ObjectStore } from "./jobs";
import {
  CompileUsageCore,
  checkCompileAdmission,
  withCompileUsage,
  type CompileUsage,
} from "./limits";
import { jobIdSchema } from "./project";
import {
  compileQueue,
  createLegacyConsumer,
  processQueueMessage,
} from "./queues";

export function createLocalRuntime(options: {
  path: string;
  engine: Engine;
  projectEngine: (projectId: string, store: ObjectStore) => Engine;
}) {
  mkdirSync(dirname(options.path), { recursive: true });
  const db = new Database(options.path, { strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, body BLOB NOT NULL, metadata TEXT);
    CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS compile_usage (userId TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS coordinators (projectId TEXT PRIMARY KEY, state TEXT NOT NULL, alarm INTEGER);
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, lane TEXT NOT NULL, body TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL
    );
  `);
  if (
    !db
      .query<{ name: string }, []>("PRAGMA table_info(objects)")
      .all()
      .some((column) => column.name === "uploaded")
  )
    db.exec(
      "ALTER TABLE objects ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0",
    );
  const read = db.query<{ body: Uint8Array }, [string]>(
    "SELECT body FROM objects WHERE key = ?",
  );
  const head = db.query<{ size: number; metadata: string | null }, [string]>(
    "SELECT length(body) AS size, metadata FROM objects WHERE key = ?",
  );
  const create = db.query(
    "INSERT OR IGNORE INTO objects (key, body, metadata, uploaded) VALUES (?, ?, ?, ?)",
  );
  const write = db.query(
    "INSERT OR REPLACE INTO objects (key, body, uploaded) VALUES (?, ?, ?)",
  );
  const remove = db.query("DELETE FROM objects WHERE key = ?");
  const keys = db.query<{ key: string }, [string, number]>(
    "SELECT key FROM objects WHERE key GLOB ? AND uploaded < ?",
  );
  const encoder = new TextEncoder();
  const store: ObjectStore = {
    async read(key) {
      const row = read.get(key);
      if (!row) return null;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(row.body);
          controller.close();
        },
      });
    },
    async head(key) {
      const object = head.get(key);
      return object
        ? { size: object.size, metadata: object.metadata ?? undefined }
        : null;
    },
    async create(key, value, metadata) {
      return (
        create.run(
          key,
          typeof value === "string" ? encoder.encode(value) : value,
          metadata ?? null,
          Date.now(),
        ).changes > 0
      );
    },
    async write(key, value) {
      write.run(
        key,
        typeof value === "string" ? encoder.encode(value) : value,
        Date.now(),
      );
    },
    async remove(key) {
      remove.run(key);
    },
    async *keys(prefix, before = Number.MAX_SAFE_INTEGER) {
      for (const row of keys.all(`${prefix}*`, before)) yield row.key;
    },
  };
  const enqueue = db.query(
    "INSERT OR IGNORE INTO deliveries (id, lane, body, due, attempts) VALUES (?, ?, ?, ?, ?)",
  );
  const send = async (lane: string, body: unknown, delaySeconds = 0) => {
    enqueue.run(
      crypto.randomUUID(),
      lane,
      JSON.stringify(body),
      Date.now() + delaySeconds * 1000,
      0,
    );
  };
  for (const row of db
    .query<{ id: string; attempts: number; due: number }, []>(
      "SELECT * FROM queue",
    )
    .all()) {
    enqueue.run(
      row.id,
      "compile-free",
      JSON.stringify({ projectId: row.id, revision: 0 }),
      row.due,
      Math.min(row.attempts, 1),
    );
    db.query("DELETE FROM queue WHERE id = ?").run(row.id);
  }
  const next = db.query<
    { id: string; body: string; attempts: number },
    [string, number, number]
  >(
    "SELECT id, body, attempts FROM deliveries WHERE lane = ? AND due <= ? ORDER BY due, rowid LIMIT ?",
  );
  const retry = db.query(
    "UPDATE deliveries SET attempts = attempts + 1, due = ? WHERE id = ?",
  );
  const ack = db.query("DELETE FROM deliveries WHERE id = ?");
  const readUsage = db.query<{ state: string }, [string]>(
    "SELECT state FROM compile_usage WHERE userId = ?",
  );
  const writeUsage = db.query(
    "INSERT OR REPLACE INTO compile_usage VALUES (?, ?)",
  );
  const usageFor = (userId: string): CompileUsage => {
    const core = new CompileUsageCore({
      read: () => readUsage.get(userId)?.state ?? null,
      write: (value) => {
        writeUsage.run(userId, value);
      },
    });
    return {
      async check(plan) {
        return core.check(plan);
      },
      async start(plan) {
        return core.start(plan);
      },
      async finish(id, ms) {
        core.finish(id, ms);
      },
    };
  };
  const rateWindows = new Map<string, { count: number; resetsAt: number }>();
  const limiter = {
    async limit({ key }: { key: string }) {
      let window = rateWindows.get(key);
      if (!window || Date.now() >= window.resetsAt) {
        window = { count: 0, resetsAt: Date.now() + 10_000 };
        rateWindows.set(key, window);
      }
      return { success: ++window.count <= 2 };
    },
  };
  let anonymousCount = 0;
  let anonymousResetsAt = 0;
  const admit = async (request: Request) => {
    if (request.headers.has("X-Compile-User"))
      return checkCompileAdmission(request, limiter, usageFor);
    // Local scripts predate authenticated compilation. Production always requires identity.
    if (new URL(request.url).pathname !== "/compile") return null;
    if (Date.now() >= anonymousResetsAt) {
      anonymousCount = 0;
      anonymousResetsAt = Date.now() + 60_000;
    }
    return ++anonymousCount <= 10
      ? null
      : Response.json(
          { error: "Too many compile requests" },
          { status: 429, headers: { "Retry-After": "60" } },
        );
  };
  const jobs = createJobs({
    store,
    engine: withCompileUsage(options.engine, usageFor),
    queue: {
      async send({ id }, plan) {
        await send(compileQueue(plan), { projectId: id, revision: 0 });
      },
    },
  });
  const app = createApp();
  const legacy = createLegacyConsumer(jobs);
  let closed = false;
  const loadCoordinator = db.query<
    { state: string; alarm: number | null },
    [string]
  >("SELECT state, alarm FROM coordinators WHERE projectId = ?");
  const saveCoordinator = db.query(
    "INSERT INTO coordinators (projectId, state) VALUES (?, ?) ON CONFLICT(projectId) DO UPDATE SET state = excluded.state",
  );
  const scheduleCoordinator = db.query(
    "UPDATE coordinators SET alarm = ? WHERE projectId = ?",
  );
  const coordinators = new Map<
    string,
    {
      core: ProjectCoordinatorCore;
      app: ReturnType<typeof createCoordinatorApp>;
      alarm: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  function coordinatorFor(projectId: string) {
    const existing = coordinators.get(projectId);
    if (existing) return existing;
    const saved = loadCoordinator.get(projectId);
    const schedule = async (at: number) => {
      if (closed) return;
      scheduleCoordinator.run(at, projectId);
      clearTimeout(entry.alarm);
      entry.alarm = setTimeout(
        () => {
          void core.wake().catch((error) => {
            console.error("Local project coordinator failed", {
              projectId,
              error,
            });
            void schedule(Date.now() + 1000);
          });
        },
        Math.min(24 * 60 * 60_000, Math.max(0, at - Date.now())),
      );
    };
    const core = new ProjectCoordinatorCore({
      projectId,
      saved: saved?.state ?? null,
      save: (value) => {
        saveCoordinator.run(projectId, value);
      },
      schedule,
      overflow: (message, plan) => send(compileQueue(plan), message),
      background: (message, delaySeconds) =>
        send("background", message, delaySeconds),
      store,
      engine: withCompileUsage(
        options.projectEngine(projectId, store),
        usageFor,
      ),
    });
    const entry: {
      core: ProjectCoordinatorCore;
      app: ReturnType<typeof createCoordinatorApp>;
      alarm: ReturnType<typeof setTimeout> | undefined;
    } = { core, app: createCoordinatorApp(core, admit), alarm: undefined };
    coordinators.set(projectId, entry);
    if (saved?.alarm) void schedule(saved.alarm);
    return entry;
  }
  for (const row of db
    .query<{ projectId: string }, []>("SELECT projectId FROM coordinators")
    .all())
    coordinatorFor(row.projectId);
  const bindings: ApiBindings = { jobs, admit };
  let recoverAt = 0;
  async function drain(lane: string, concurrency: number) {
    await Promise.all(
      next.all(lane, Date.now(), concurrency).map(async (row) => {
        let completed = false;
        try {
          completed = await processQueueMessage({
            queue: lane,
            body: JSON.parse(row.body),
            attempts: row.attempts + 1,
            jobs,
            legacy,
            coordinator: (projectId) => coordinatorFor(projectId).core,
          });
        } catch (error) {
          console.error("Local compile queue processing failed", {
            jobId: row.id,
            error,
          });
        }
        if (completed) ack.run(row.id);
        else if (
          (lane === "compile-pro" || lane === "compile-free") &&
          row.attempts >= 1
        ) {
          await send("compile-dlq", JSON.parse(row.body));
          ack.run(row.id);
        } else retry.run(Date.now() + 5_000, row.id);
      }),
    );
  }
  const active = new Map<string, Promise<void>>();
  const timer = setInterval(() => {
    if (Date.now() >= recoverAt) {
      void send("background", { kind: "recover" });
      recoverAt = Date.now() + 5 * 60_000;
    }
    for (const [lane, concurrency] of [
      ["compile-pro", 4],
      ["compile-free", 1],
      ["compile-dlq", 2],
      ["background", 1],
    ] satisfies [string, number][]) {
      if (active.has(lane)) continue;
      const work = drain(lane, concurrency)
        .catch((error) => {
          console.error("Local compile queue failed", { error });
        })
        .finally(() => {
          active.delete(lane);
        });
      active.set(lane, work);
    }
  }, 250);
  return {
    fetch: (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/projects/")) {
        const id = jobIdSchema.safeParse(path.split("/")[2]);
        if (!id.success)
          return Promise.resolve(
            Response.json({ error: "Invalid project ID" }, { status: 400 }),
          );
        return coordinatorFor(id.data).app.fetch(request);
      }
      return app.fetch(request, bindings);
    },
    async close() {
      closed = true;
      clearInterval(timer);
      for (const entry of coordinators.values()) clearTimeout(entry.alarm);
      await Promise.all(
        [...coordinators.values()].map((entry) => entry.core.close()),
      );
      await Promise.all(active.values());
      db.close();
    },
  };
}
