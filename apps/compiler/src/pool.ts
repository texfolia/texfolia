import { z } from "zod";

import { planSchema } from "./telemetry";

export const poolClaimSchema = z.object({
  container: z.string(),
  generation: z.number().int().positive(),
  outcome: z.enum(["hit", "miss"]),
});
export type PoolClaim = z.infer<typeof poolClaimSchema>;
// Covers startup, archive restore, the 300s compile, and response transfer.
export const poolLeaseMs = 15 * 60_000;
const stateSchema = z
  .object({
    version: z.literal(2).optional(),
    target: z.number(),
    hits: z.number(),
    misses: z.number(),
    windowHits: z.number(),
    windowMisses: z.number(),
    windowStarted: z.number(),
    lastClaim: z.number(),
    spares: z.array(
      z.object({
        name: z.string(),
        generation: z.number().int().nonnegative().default(0),
        status: z.enum(["warming", "ready", "stopping"]),
      }),
    ),
    leases: z
      .array(
        z.object({
          key: z.string(),
          container: z.string(),
          generation: z.number().int().positive(),
          claimId: z.string(),
          expiresAt: z.number(),
          status: z.enum(["leased", "resetting"]),
        }),
      )
      .default([]),
  })
  .transform((state) => ({
    ...state,
    version: 2 as const,
    // Old spares may run an image without lease endpoints. Retire them before reuse.
    spares:
      state.version === undefined
        ? state.spares.map((entry) => ({
            ...entry,
            status: "stopping" as const,
          }))
        : state.spares,
  }));

export class PoolCore {
  private state: z.infer<typeof stateSchema>;
  private releasing = new Map<string, Promise<void>>();
  private starting = new Map<string, Promise<void>>();
  private maintaining: Promise<void> | undefined;
  constructor(
    private options: {
      saved: string | null;
      save: (value: string) => void;
      lookup: (key: string) => PoolClaim | undefined;
      assign: (key: string, claim: PoolClaim) => void;
      start: (name: string) => Promise<void>;
      stop: (name: string) => Promise<void>;
      reset: (name: string, token: string) => Promise<void>;
      now: () => number;
      pause: () => Promise<void>;
    },
  ) {
    this.state = options.saved
      ? stateSchema.parse(JSON.parse(options.saved))
      : {
          version: 2,
          target: 1,
          hits: 0,
          misses: 0,
          windowHits: 0,
          windowMisses: 0,
          windowStarted: options.now(),
          lastClaim: options.now(),
          spares: [],
          leases: [],
        };
  }
  private persist() {
    this.options.save(JSON.stringify(this.state));
  }
  snapshot() {
    return structuredClone(this.state);
  }

  async claim(
    projectId: string,
    plan: z.infer<typeof planSchema>,
    claimId: string,
  ): Promise<PoolClaim> {
    const key = `${projectId}:${claimId}`;
    const existing = this.options.lookup(key);
    if (existing) return this.existingClaim(key, existing);
    // Pro can claim immediately; Free contenders yield one arbitration window.
    if (plan !== "pro" && plan !== "team") await this.options.pause();
    const retried = this.options.lookup(key);
    if (retried) return this.existingClaim(key, retried);
    const spare = this.state.spares.find((entry) => entry.status === "ready");
    const result: PoolClaim = spare
      ? {
          container: spare.name,
          generation: spare.generation + 1,
          outcome: "hit",
        }
      : {
          container: `pooled:${crypto.randomUUID()}`,
          generation: 1,
          outcome: "miss",
        };
    this.state.leases.push({
      key,
      container: result.container,
      generation: result.generation,
      claimId,
      expiresAt: this.options.now() + poolLeaseMs,
      status: "leased",
    });
    // The adapter commits the assignment and state in the same synchronous transaction.
    this.options.assign(key, result);
    if (spare) {
      this.state.spares = this.state.spares.filter((entry) => entry !== spare);
      this.state.hits++;
      this.state.windowHits++;
    } else {
      this.state.misses++;
      this.state.windowMisses++;
    }
    this.state.lastClaim = this.options.now();
    this.persist();
    return result;
  }

  private existingClaim(key: string, claim: PoolClaim) {
    const lease = this.state.leases.find((entry) => entry.key === key);
    if (
      !lease ||
      lease.status !== "leased" ||
      lease.expiresAt <= this.options.now()
    )
      throw new Error("Container lease has ended");
    return claim;
  }

  release(projectId: string, claimId: string): Promise<void> {
    return this.releaseKey(`${projectId}:${claimId}`);
  }

  private releaseKey(key: string): Promise<void> {
    const pending = this.releasing.get(key);
    if (pending) return pending;
    const release = this.releaseLease(key).finally(() =>
      this.releasing.delete(key),
    );
    this.releasing.set(key, release);
    return release;
  }

  private async releaseLease(key: string) {
    const lease = this.state.leases.find((entry) => entry.key === key);
    if (!lease) return;
    lease.status = "resetting";
    this.persist();
    await this.options.reset(
      lease.container,
      `${lease.generation}:${lease.claimId}`,
    );
    this.state.leases = this.state.leases.filter((entry) => entry !== lease);
    // Prefer the just-used process over a spare replenished during this job.
    this.state.spares.unshift({
      name: lease.container,
      generation: lease.generation,
      status: "ready",
    });
    this.trim();
    this.persist();
    await this.stopSurplus();
  }

  private trim() {
    const live = this.state.spares.filter(
      (entry) => entry.status !== "stopping",
    );
    for (const entry of live.slice(this.state.target))
      entry.status = "stopping";
  }

  private async stopSurplus() {
    for (const entry of this.state.spares.filter(
      (entry) => entry.status === "stopping",
    )) {
      await this.starting.get(entry.name)?.catch(() => {});
      await this.options.stop(entry.name);
      this.state.spares = this.state.spares.filter((spare) => spare !== entry);
      this.persist();
    }
  }

  maintain(): Promise<void> {
    this.maintaining ??= this.maintainInventory().finally(() => {
      this.maintaining = undefined;
    });
    return this.maintaining;
  }

  private async maintainInventory() {
    const now = this.options.now();
    for (const lease of this.state.leases.filter(
      (entry) => entry.status === "resetting" || entry.expiresAt <= now,
    )) {
      await this.releaseKey(lease.key);
    }
    if (now - this.state.windowStarted >= 60_000) {
      const claims = this.state.windowHits + this.state.windowMisses;
      if (
        this.state.windowMisses >= 2 &&
        this.state.windowMisses / claims >= 0.25
      )
        this.state.target = 2;
      else if (now - this.state.lastClaim >= 5 * 60_000) this.state.target = 1;
      this.state.windowHits = 0;
      this.state.windowMisses = 0;
      this.state.windowStarted = now;
    }
    this.trim();
    while (
      this.state.spares.filter((entry) => entry.status !== "stopping").length <
      this.state.target
    )
      this.state.spares.push({
        name: `spare:${crypto.randomUUID()}`,
        generation: 0,
        status: "warming",
      });
    this.persist();
    for (const entry of this.state.spares) {
      if (!this.state.spares.includes(entry)) continue;
      if (entry.status === "stopping") {
        await this.starting.get(entry.name)?.catch(() => {});
        await this.options.stop(entry.name);
        this.state.spares = this.state.spares.filter(
          (spare) => spare !== entry,
        );
      } else {
        // Remove availability during health checks so claims cannot race a restart.
        entry.status = "warming";
        this.persist();
        const starting = this.options.start(entry.name);
        this.starting.set(entry.name, starting);
        try {
          await starting;
        } finally {
          this.starting.delete(entry.name);
        }
        if (entry.status === "warming") entry.status = "ready";
      }
      this.persist();
    }
  }
}
