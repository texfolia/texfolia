import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Effect, Layer, ManagedRuntime, Schedule } from "effect";

import { Background } from "./background";
import { serve } from "./compile";
import { PoolConfig } from "./config";
import type { Containers } from "./containers";
import { PoolManagerService, PoolStore } from "./pool";

/** Keeps the pool's state across restarts of the local process. */
export const sqliteStore = (path: string) =>
  Layer.effect(
    PoolStore,
    Effect.acquireRelease(
      Effect.sync(() => {
        mkdirSync(dirname(path), { recursive: true });
        const db = new Database(path, { strict: true });
        db.run("PRAGMA journal_mode = WAL");
        db.run(
          "CREATE TABLE IF NOT EXISTS pool (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)",
        );
        return db;
      }),
      (db) => Effect.sync(() => db.close()),
    ).pipe(
      Effect.map((db) =>
        PoolStore.of({
          load: () =>
            db
              .query<{ value: string }, []>(
                "SELECT value FROM pool WHERE id = 1",
              )
              .get()?.value ?? null,
          save: (value) => {
            db.run("INSERT OR REPLACE INTO pool VALUES (1, ?)", [value]);
          },
        }),
      ),
    ),
  );

/** The compiler in one process: the Worker's programs with local services. */
export function createLocalCompiler(options: {
  variables: unknown;
  store: Layer.Layer<PoolStore>;
  containers: Layer.Layer<Containers>;
  maintenance?: boolean;
}) {
  const manager = PoolManagerService.layer.pipe(
    Layer.provide(options.store),
    Layer.provide(PoolConfig.layer(options.variables)),
  );
  const maintenance = Layer.effectDiscard(
    Effect.gen(function* () {
      const pool = yield* PoolManagerService;
      yield* pool.maintain.pipe(
        Effect.repeat(Schedule.spaced("60 seconds")),
        Effect.forkScoped,
      );
    }),
  );
  const services = PoolManagerService.poolLayer.pipe(
    Layer.merge(options.maintenance === false ? Layer.empty : maintenance),
    Layer.provideMerge(manager),
    Layer.provideMerge(options.containers),
    Layer.provideMerge(
      Layer.succeed(Background, {
        run: (effect) => {
          Effect.runFork(effect);
        },
      }),
    ),
  );
  const runtime = ManagedRuntime.make(services);
  return {
    fetch: (request: Request) =>
      serve(request, (program, options) =>
        runtime.runPromiseExit(program, options),
      ),
    snapshot: () =>
      runtime.runPromise(PoolManagerService.use((pool) => pool.snapshot)),
    maintain: () =>
      runtime.runPromise(PoolManagerService.use((pool) => pool.maintain)),
    close: () => runtime.dispose(),
  };
}
