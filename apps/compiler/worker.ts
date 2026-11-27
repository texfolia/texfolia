import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";

import { handle } from "./src/compile";
import { poolSettings } from "./src/config";
import type { ContainerPlatform } from "./src/containers";
import { MaintenanceAlarm } from "./src/maintenance-alarm";
import {
  claimRequestSchema,
  claimResultSchema,
  createPoolManager,
  leaseSchema,
  type ClaimResult,
  type Lease,
  type PoolClient,
  type PoolManagerCore,
  type PoolStore,
} from "./src/pool";

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

function cloudflareContainers(env: Env): ContainerPlatform {
  const stub = (name: string) => getContainer(env.COMPILER, name);
  return {
    async start(name, signal) {
      await stub(name).startAndWaitForPorts();
      const response = await stub(name).fetch(
        new Request("http://container/health", { signal }),
      );
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(`Container health returned ${response.status}`);
    },
    async stop(name) {
      await stub(name).destroy();
    },
    fetch(name, request, signal) {
      return stub(name).fetch(new Request(request, { signal }));
    },
  };
}

interface PoolRpc {
  claim(request: unknown): Promise<ClaimResult>;
  release(id: string, reusable: boolean): Promise<void>;
  cancel(id: string): Promise<Lease | null>;
}

/** The calling side of the PoolManager DO. A lost pool is unavailable, never a throw. */
function poolClient(rpc: PoolRpc): PoolClient {
  return {
    async claim(request) {
      try {
        const reply = claimResultSchema.safeParse(await rpc.claim(request));
        if (reply.success) return reply.data;
      } catch {
        // Fall through to unavailable.
      }
      return {
        ok: false,
        code: "unavailable",
        message: "The compile pool is unavailable",
      };
    },
    // A release that cannot be delivered is recovered when its lease expires.
    async release(id, { reusable }) {
      try {
        await rpc.release(id, reusable);
      } catch (cause) {
        console.error("Compile lease release failed", { id, cause });
      }
    },
    async cancel(id) {
      try {
        const parsed = leaseSchema.nullable().safeParse(await rpc.cancel(id));
        if (parsed.success) return parsed.data;
      } catch (cause) {
        console.error("Compile cancellation failed", { id, cause });
      }
      return null;
    },
  };
}

/** Owns the container pool: leases, the waiting queue, and autoscaling. */
export class PoolManager extends DurableObject<Env> {
  private pool: PoolManagerCore;
  private maintenance: MaintenanceAlarm;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.maintenance = new MaintenanceAlarm(ctx.storage);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pool (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)",
    );
    const store: PoolStore = {
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
    };
    this.pool = createPoolManager({
      settings: poolSettings(env),
      containers: cloudflareContainers(env),
      store,
      waitUntil: (task) => ctx.waitUntil(task),
    });
  }

  async claim(request: unknown): Promise<ClaimResult> {
    return this.maintenance.claim(() =>
      this.pool.claim(claimRequestSchema.parse(request)),
    );
  }

  async release(id: string, reusable: boolean) {
    await this.pool.release(id, { reusable });
  }

  async cancel(id: string) {
    return this.pool.cancel(id);
  }

  override async alarm() {
    await this.maintenance.fire(
      async () => {
        await this.pool.maintain();
        const { containers, ...state } = this.pool.snapshot();
        const count = (status: (typeof containers)[number]["status"]) =>
          containers.filter((container) => container.status === status).length;
        console.info({
          event: "compile_pool",
          telemetryVersion: 2,
          ...state,
          starting: count("starting"),
          ready: count("ready"),
          draining: count("draining"),
          stopping: count("stopping"),
          leased: containers.filter((c) => c.slots.some((s) => s.lease)).length,
        });
      },
      () => this.pool.idle(),
    );
  }
}

export default {
  fetch(request, env, ctx) {
    const served = handle(request, {
      pool: poolClient(env.POOL.getByName("autoscaler")),
      containers: cloudflareContainers(env),
      waitUntil: (task) => ctx.waitUntil(task),
    });
    // A caller that goes away must not stop its own cleanup.
    ctx.waitUntil(served);
    return served;
  },
} satisfies ExportedHandler<Env>;
