import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { handle } from "./compile";
import { poolSettings } from "./config";
import type { ContainerPlatform } from "./containers";
import { createPoolManager, type PoolStore } from "./pool";

/** Keeps the pool's state across restarts of the local process. */
export function sqliteStore(path: string): PoolStore & { close(): void } {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(
    "CREATE TABLE IF NOT EXISTS pool (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)",
  );
  return {
    load: () =>
      db
        .query<{ value: string }, []>("SELECT value FROM pool WHERE id = 1")
        .get()?.value ?? null,
    save: (value) => {
      db.run("INSERT OR REPLACE INTO pool VALUES (1, ?)", [value]);
    },
    close: () => db.close(),
  };
}

/** The compiler in one process: the Worker's handlers with local services. */
export function createLocalCompiler(options: {
  variables: unknown;
  store: PoolStore & { close?: () => void };
  containers: ContainerPlatform;
  maintenance?: boolean;
}) {
  const pending = new Set<Promise<unknown>>();
  const waitUntil = (task: Promise<unknown>) => {
    const tracked = task.finally(() => {
      pending.delete(tracked);
    });
    pending.add(tracked);
  };
  const pool = createPoolManager({
    settings: poolSettings(options.variables),
    containers: options.containers,
    store: options.store,
    waitUntil,
  });
  let interval: ReturnType<typeof setInterval> | undefined;
  if (options.maintenance !== false) {
    interval = setInterval(() => {
      void pool.maintain();
    }, 60_000);
  }
  return {
    fetch: (request: Request) =>
      handle(request, {
        pool,
        containers: options.containers,
        waitUntil,
      }),
    snapshot: () => Promise.resolve(pool.snapshot()),
    maintain: () => pool.maintain(),
    close: async () => {
      if (interval) clearInterval(interval);
      pool.dispose();
      await Promise.allSettled(pending);
      options.store.close?.();
    },
  };
}
