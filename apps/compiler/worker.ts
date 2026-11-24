import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime } from "effect";

import { Background } from "./src/background";
import { serve } from "./src/compile";
import { PoolConfig, poolSettings } from "./src/config";
import { Containers } from "./src/containers";
import { ContainerError } from "./src/errors";
import { MaintenanceAlarm } from "./src/maintenance-alarm";
import { Pool, PoolManagerService, PoolStore } from "./src/pool";
import { poolClient, serveClaim } from "./src/pool-rpc";

/** One compile container. Its pool decides when it runs. */
export class TectonicContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter: string | number;
  override envVars: Record<string, string>;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const settings = poolSettings(env);
    this.sleepAfter = settings.idleMs / 1000;
    this.envVars = { COMPILE_SLOTS: String(settings.concurrency) };
  }
}

const cloudflareContainers = (env: Env) => {
  const attempt = <A>(
    operation: string,
    container: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new ContainerError({ operation, container, cause }),
    });
  const stub = (name: string) => getContainer(env.COMPILER, name);
  const health = (operation: string, name: string) =>
    attempt(operation, name, async (signal) => {
      const response = await stub(name).fetch(
        new Request("http://container/health", { signal }),
      );
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(`Container health returned ${response.status}`);
    });
  return Containers.of({
    start: (name) =>
      attempt("start", name, () => stub(name).startAndWaitForPorts()).pipe(
        Effect.andThen(health("start", name)),
      ),
    probe: (name) => health("probe", name),
    stop: (name) => attempt("stop", name, () => stub(name).destroy()),
    fetch: (name, request) =>
      attempt("fetch", name, (signal) =>
        stub(name).fetch(new Request(request, { signal })),
      ),
  });
};

const background = (ctx: Pick<ExecutionContext, "waitUntil">) =>
  Layer.succeed(Background, {
    run: (effect) => ctx.waitUntil(Effect.runPromise(effect)),
  });

const maintain = Effect.fnUntraced(function* (
  pool: PoolManagerService["Service"],
) {
  yield* pool.maintain;
  const { containers, ...state } = yield* pool.snapshot;
  const count = (status: (typeof containers)[number]["status"]) =>
    containers.filter((container) => container.status === status).length;
  yield* Effect.sync(() =>
    console.info({
      event: "compile_pool",
      telemetryVersion: 2,
      ...state,
      starting: count("starting"),
      ready: count("ready"),
      draining: count("draining"),
      stopping: count("stopping"),
      leased: containers.filter((c) => c.slots.some((s) => s.lease)).length,
    }),
  );
});

/** Owns the container pool: leases, the waiting queue, and autoscaling. */
export class PoolManager extends DurableObject<Env> {
  private runtime: ManagedRuntime.ManagedRuntime<PoolManagerService, never>;
  private maintenance: MaintenanceAlarm;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.maintenance = new MaintenanceAlarm(ctx.storage);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pool (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)",
    );
    const store = PoolStore.of({
      load: () =>
        ctx.storage.sql
          .exec<{ value: string }>("SELECT value FROM pool WHERE id = 1")
          .toArray()[0]?.value ?? null,
      save: (value) => {
        ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO pool VALUES (1, ?)",
          value,
        );
      },
    });
    this.runtime = ManagedRuntime.make(
      PoolManagerService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            PoolConfig.layer(env),
            Layer.succeed(PoolStore, store),
            background(ctx),
            Layer.succeed(Containers, cloudflareContainers(env)),
          ),
        ),
      ),
    );
  }

  async claim(request: unknown) {
    return this.maintenance.claim(() =>
      this.runtime.runPromise(
        PoolManagerService.use((pool) => serveClaim(pool, request)),
      ),
    );
  }

  async release(id: string, reusable: boolean) {
    await this.runtime.runPromise(
      PoolManagerService.use((pool) => pool.release(id, { reusable })),
    );
  }

  async cancel(id: string) {
    return this.runtime.runPromise(
      PoolManagerService.use((pool) => pool.cancel(id)),
    );
  }

  override async alarm() {
    await this.maintenance.fire(
      () => this.runtime.runPromise(PoolManagerService.use(maintain)),
      () => this.runtime.runSync(PoolManagerService.use((pool) => pool.idle)),
    );
  }
}

export default {
  fetch(request, env, ctx) {
    const layer = Layer.mergeAll(
      Layer.succeed(Pool, poolClient(env.POOL.getByName("autoscaler"))),
      Layer.succeed(Containers, cloudflareContainers(env)),
      background(ctx),
    );
    const served = serve(request, (program, options) =>
      Effect.runPromiseExit(program.pipe(Effect.provide(layer)), options),
    );
    // A caller that goes away must not stop its own cleanup.
    ctx.waitUntil(served);
    return served;
  },
} satisfies ExportedHandler<Env>;
