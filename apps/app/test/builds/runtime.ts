import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { jobIdSchema } from "@texfolia/contracts";

import { ProjectCoordinatorCore } from "#/lib/builds/coordinator";
import { createCoordinatorApp } from "#/lib/builds/coordinator-api";
import {
  CompileUsageCore,
  checkCompileAdmission,
  withCompileUsage,
  type CompileUsage,
} from "#/lib/builds/limits";
import { compileQueue, processQueueMessage } from "#/lib/builds/queues";
import type { ObjectStore, SourceStore } from "#/lib/builds/types";

import { streamed, type TestEngine } from "./engine";
import { bufferedUpload } from "./stores";

// Runs the build coordinators in this process with durable SQLite state, so
// tests can exercise restarts, queues, and alarms without Workers.
export function createBuildsRuntime(options: {
  path: string;
  projectEngine: (projectId: string, store: ObjectStore) => TestEngine;
}) {
  mkdirSync(dirname(options.path), { recursive: true });
  const db = new Database(options.path, { strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, body BLOB NOT NULL, uploaded INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS saved (key TEXT PRIMARY KEY, body BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts (projectId TEXT NOT NULL, hash TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY (projectId, hash));
    CREATE TABLE IF NOT EXISTS compile_usage (userId TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS coordinators (projectId TEXT PRIMARY KEY, state TEXT NOT NULL, alarm INTEGER);
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, lane TEXT NOT NULL, body TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL
    );
  `);
  const read = db.query<{ body: Uint8Array }, [string]>(
    "SELECT body FROM objects WHERE key = ?",
  );
  const create = db.query("INSERT OR IGNORE INTO objects VALUES (?, ?, ?)");
  const write = db.query("INSERT OR REPLACE INTO objects VALUES (?, ?, ?)");
  const remove = db.query("DELETE FROM objects WHERE key = ?");
  const keys = db.query<{ key: string }, [string, number]>(
    "SELECT key FROM objects WHERE key GLOB ? AND uploaded < ?",
  );
  const encode = (value: string | Uint8Array) =>
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const open: ObjectStore["open"] = async (key, offset = 0) => {
    const row = read.get(key);
    return row
      ? {
          size: row.body.length,
          body: new Blob([new Uint8Array(row.body).slice(offset)]).stream(),
        }
      : null;
  };
  const store: ObjectStore = {
    open,
    read: async (key) => (await open(key))?.body ?? null,
    async create(key, value) {
      return create.run(key, encode(value), Date.now()).changes > 0;
    },
    async write(key, value) {
      write.run(key, encode(value), Date.now());
    },
    upload: (key, size, { create: exclusive }) =>
      bufferedUpload(
        size,
        async (bytes) =>
          (exclusive ? create : write).run(key, bytes, Date.now()).changes > 0,
      ),
    async remove(key) {
      remove.run(key);
    },
    async *keys(prefix, before = Number.MAX_SAFE_INTEGER) {
      for (const row of keys.all(`${prefix}*`, before)) yield row.key;
    },
  };
  const readSaved = db.query<{ body: Uint8Array }, [string]>(
    "SELECT body FROM saved WHERE key = ?",
  );
  const readDraft = db.query<{ body: Uint8Array }, [string, string]>(
    "SELECT body FROM drafts WHERE projectId = ? AND hash = ?",
  );
  const sourcesFor = (projectId: string): SourceStore => ({
    saved: {
      size: async (key) => readSaved.get(key)?.body.length ?? null,
      async open(key) {
        const row = readSaved.get(key);
        return row
          ? {
              size: row.body.length,
              body: new Blob([new Uint8Array(row.body)]).stream(),
            }
          : null;
      },
    },
    drafts: {
      size: (hash) => readDraft.get(projectId, hash)?.body.length ?? null,
      read(hash) {
        const row = readDraft.get(projectId, hash);
        return row ? new Uint8Array(row.body) : null;
      },
      write(hash, bytes) {
        db.run("INSERT OR IGNORE INTO drafts VALUES (?, ?, ?)", [
          projectId,
          hash,
          bytes,
        ]);
      },
      retain(hashes) {
        for (const { hash } of db
          .query<{ hash: string }, [string]>(
            "SELECT hash FROM drafts WHERE projectId = ?",
          )
          .all(projectId))
          if (!hashes.has(hash))
            db.run("DELETE FROM drafts WHERE projectId = ? AND hash = ?", [
              projectId,
              hash,
            ]);
      },
    },
  });
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
  // Local scripts may omit identity; production always sends X-Compile-User.
  const admit = async (request: Request) =>
    request.headers.has("X-Compile-User")
      ? checkCompileAdmission(request, limiter, usageFor)
      : null;
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
    const rawEngine = streamed(options.projectEngine(projectId, store));
    const meteredEngine = withCompileUsage(rawEngine, usageFor);
    const core = new ProjectCoordinatorCore({
      projectId,
      saved: saved?.state ?? null,
      save: (value) => {
        saveCoordinator.run(projectId, value);
      },
      schedule,
      overflow: (message, plan) => send(compileQueue(plan), message),
      store,
      sources: sourcesFor(projectId),
      engine: (project, context) =>
        context.userId
          ? meteredEngine(project, context)
          : rawEngine(project, context),
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
  async function drain(lane: string, concurrency: number) {
    await Promise.all(
      next.all(lane, Date.now(), concurrency).map(async (row) => {
        let completed = false;
        try {
          completed = await processQueueMessage({
            queue: lane,
            body: JSON.parse(row.body),
            attempts: row.attempts + 1,
            coordinator: (projectId) => coordinatorFor(projectId).core,
            deliverEmail: () =>
              Promise.reject(new Error("Builds do not send email")),
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
    for (const [lane, concurrency] of [
      ["compile-pro", 4],
      ["compile-free", 1],
      ["compile-dlq", 2],
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
    store,
    /** Puts a source in the app's bucket, as saving a file does. */
    save: (key: string, bytes: Uint8Array) => {
      db.run("INSERT OR REPLACE INTO saved VALUES (?, ?)", [key, bytes]);
    },
    drafts: (projectId: string) =>
      db
        .query<{ hash: string }, [string]>(
          "SELECT hash FROM drafts WHERE projectId = ? ORDER BY hash",
        )
        .all(projectId)
        .map(({ hash }) => hash),
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
      return Promise.resolve(
        path === "/health"
          ? Response.json(
              { status: "ready" },
              { headers: { "Cache-Control": "no-store" } },
            )
          : Response.json({ error: "Not found" }, { status: 404 }),
      );
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
