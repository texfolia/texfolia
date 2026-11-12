import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type ApiBindings, createApp } from "./api";
import { ProjectCoordinatorCore } from "./coordinator";
import { createCoordinatorApp } from "./coordinator-api";
import { createJobs, type Engine, type ObjectStore } from "./jobs";
import { jobIdSchema } from "./project";

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
    CREATE TABLE IF NOT EXISTS coordinators (projectId TEXT PRIMARY KEY, state TEXT NOT NULL, alarm INTEGER);
  `);
  const read = db.query<{ body: Uint8Array }, [string]>(
    "SELECT body FROM objects WHERE key = ?",
  );
  const head = db.query<{ size: number; metadata: string | null }, [string]>(
    "SELECT length(body) AS size, metadata FROM objects WHERE key = ?",
  );
  const create = db.query("INSERT OR IGNORE INTO objects VALUES (?, ?, ?)");
  const write = db.query(
    "INSERT OR REPLACE INTO objects (key, body) VALUES (?, ?)",
  );
  const remove = db.query("DELETE FROM objects WHERE key = ?");
  const keys = db.query<{ key: string }, [string]>(
    "SELECT key FROM objects WHERE key GLOB ?",
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
        ).changes > 0
      );
    },
    async write(key, value) {
      write.run(key, typeof value === "string" ? encoder.encode(value) : value);
    },
    async remove(key) {
      remove.run(key);
    },
    async *keys(prefix) {
      for (const row of keys.all(`${prefix}*`)) yield row.key;
    },
  };
  const enqueue = db.query(
    "INSERT OR IGNORE INTO queue (id, due) VALUES (?, ?)",
  );
  const next = db.query<{ id: string; attempts: number }, [number]>(
    "SELECT id, attempts FROM queue WHERE due <= ? ORDER BY due, rowid LIMIT 1",
  );
  const retry = db.query(
    "UPDATE queue SET attempts = attempts + 1, due = ? WHERE id = ?",
  );
  const ack = db.query("DELETE FROM queue WHERE id = ?");
  const jobs = createJobs({
    store,
    engine: options.engine,
    queue: {
      async send({ id }) {
        enqueue.run(id, Date.now());
      },
    },
  });
  const app = createApp();
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
      overflow: async () => {},
      store,
      engine: options.projectEngine(projectId, store),
    });
    const entry: {
      core: ProjectCoordinatorCore;
      app: ReturnType<typeof createCoordinatorApp>;
      alarm: ReturnType<typeof setTimeout> | undefined;
    } = { core, app: createCoordinatorApp(core), alarm: undefined };
    coordinators.set(projectId, entry);
    if (saved?.alarm) void schedule(saved.alarm);
    return entry;
  }
  for (const row of db
    .query<{ projectId: string }, []>("SELECT projectId FROM coordinators")
    .all())
    coordinatorFor(row.projectId);
  let count = 0;
  let resetsAt = 0;
  const bindings: ApiBindings = {
    jobs,
    limiter: {
      async limit() {
        if (Date.now() >= resetsAt) {
          count = 0;
          resetsAt = Date.now() + 60_000;
        }
        return { success: ++count <= 10 };
      },
    },
  };
  let recoverAt = 0;
  async function drain() {
    if (Date.now() >= recoverAt) {
      await jobs.recover();
      recoverAt = Date.now() + 5 * 60_000;
    }
    let row = next.get(Date.now());
    while (row) {
      try {
        if (await jobs.consume(row.id, row.attempts + 1)) ack.run(row.id);
        else retry.run(Date.now() + 5_000, row.id);
      } catch (error) {
        console.error("Local compile queue processing failed", {
          jobId: row.id,
          error,
        });
        retry.run(Date.now() + 5_000, row.id);
      }
      row = next.get(Date.now());
    }
  }
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    active ??= drain()
      .catch((error) => {
        console.error("Local compile queue failed", { error });
      })
      .finally(() => {
        active = undefined;
      });
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
      await active;
      db.close();
    },
  };
}
