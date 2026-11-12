import { z } from "zod";

import { planSchema } from "./telemetry";

export const poolClaimSchema = z.object({
  container: z.string(),
  outcome: z.enum(["hit", "miss"]),
});
export type PoolClaim = z.infer<typeof poolClaimSchema>;
const stateSchema = z.object({
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
      status: z.enum(["warming", "ready", "stopping"]),
    }),
  ),
});

export class PoolCore {
  private state: z.infer<typeof stateSchema>;
  constructor(
    private options: {
      saved: string | null;
      save: (value: string) => void;
      lookup: (key: string) => PoolClaim | undefined;
      assign: (key: string, claim: PoolClaim) => void;
      start: (name: string) => Promise<void>;
      stop: (name: string) => Promise<void>;
      now: () => number;
      pause: () => Promise<void>;
    },
  ) {
    this.state = options.saved
      ? stateSchema.parse(JSON.parse(options.saved))
      : {
          target: 1,
          hits: 0,
          misses: 0,
          windowHits: 0,
          windowMisses: 0,
          windowStarted: options.now(),
          lastClaim: options.now(),
          spares: [],
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
    if (existing) return existing;
    // Pro can claim immediately; Free contenders yield one arbitration window.
    if (plan !== "pro" && plan !== "team") await this.options.pause();
    const retried = this.options.lookup(key);
    if (retried) return retried;
    const spare = this.state.spares.find((entry) => entry.status === "ready");
    const result: PoolClaim = spare
      ? { container: spare.name, outcome: "hit" }
      : { container: `project:${key}`, outcome: "miss" };
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

  async maintain() {
    const now = this.options.now();
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
    const live = this.state.spares.filter(
      (entry) => entry.status !== "stopping",
    );
    for (const entry of live.slice(this.state.target))
      entry.status = "stopping";
    while (
      this.state.spares.filter((entry) => entry.status !== "stopping").length <
      this.state.target
    )
      this.state.spares.push({
        name: `spare:${crypto.randomUUID()}`,
        status: "warming",
      });
    this.persist();
    for (const entry of this.state.spares) {
      if (!this.state.spares.includes(entry)) continue;
      if (entry.status === "stopping") {
        await this.options.stop(entry.name);
        this.state.spares = this.state.spares.filter(
          (spare) => spare !== entry,
        );
      } else {
        // Remove availability during health checks so claims cannot race a restart.
        entry.status = "warming";
        this.persist();
        await this.options.start(entry.name);
        entry.status = "ready";
      }
      this.persist();
    }
  }
}
