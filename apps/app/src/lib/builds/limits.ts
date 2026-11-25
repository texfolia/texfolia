import { planSchema } from "@texfolia/contracts";
import { z } from "zod";

import { EngineError, HttpError } from "./project";
import type { Engine } from "./types";

export type Plan = z.infer<typeof planSchema>;
export const compileUserSchema = z.string().min(1).max(256);
export const rollingWindowMs = 60 * 60_000;
export const isPaid = (plan: Plan) => plan === "pro" || plan === "team";
// Paid compiles wait less when containers are scarce: they queue ahead, and
// Free compiles yield one short arbitration window before they claim.
export function compilePolicy(plan: Plan) {
  return isPaid(plan)
    ? { timeoutMs: 300_000, fairUseMs: 600_000, priority: 1, yieldMs: 0 }
    : { timeoutMs: 15_000, fairUseMs: 180_000, priority: 0, yieldMs: 25 };
}

const usageSchema = z.object({
  completed: z.array(z.object({ at: z.number(), ms: z.number() })),
  reserved: z.array(
    z.object({ id: z.string(), until: z.number(), ms: z.number() }),
  ),
});
type Admission = { allowed: true } | { allowed: false; retryAfter: number };
type Reservation =
  | { allowed: true; id: string; timeoutMs: number }
  | { allowed: false; retryAfter: number };
export interface CompileUsage {
  check(plan: Plan): Promise<Admission>;
  start(plan: Plan): Promise<Reservation>;
  finish(id: string, compileMs: number): Promise<void>;
}

// Each adapter calls these synchronous transitions on one user's durable state.
export class CompileUsageCore {
  constructor(
    private storage: {
      read: () => string | null;
      write: (value: string) => void;
    },
    private now = Date.now,
  ) {}

  private load() {
    const saved = this.storage.read();
    const state = saved
      ? usageSchema.parse(JSON.parse(saved))
      : { completed: [], reserved: [] };
    const now = this.now();
    // A crashed attempt keeps its reserved cost; it ages out without a midnight reset.
    for (const run of state.reserved) {
      if (run.until <= now) this.record(state, run.until, run.ms);
    }
    state.reserved = state.reserved.filter((run) => run.until > now);
    state.completed = state.completed.filter(
      (run) => run.at > now - rollingWindowMs,
    );
    return state;
  }

  private record(state: z.infer<typeof usageSchema>, at: number, ms: number) {
    if (ms === 0) return;
    // Round up to a second so storage stays bounded without expiring work early.
    const bucket = Math.ceil(at / 1000) * 1000;
    const existing = state.completed.find((run) => run.at === bucket);
    if (existing) existing.ms += ms;
    else state.completed.push({ at: bucket, ms });
  }

  private allowance(state: z.infer<typeof usageSchema>, plan: Plan) {
    return (
      compilePolicy(plan).fairUseMs -
      state.completed.reduce((sum, run) => sum + run.ms, 0) -
      state.reserved.reduce((sum, run) => sum + run.ms, 0)
    );
  }

  private retryAfter(state: z.infer<typeof usageSchema>) {
    const next = Math.min(
      ...state.completed.map((run) => run.at + rollingWindowMs),
      ...state.reserved.map((run) => run.until),
    );
    return Math.max(1, Math.ceil((next - this.now()) / 1000));
  }

  // Expired entries are dropped again by every load, so reads need not write.
  check(plan: Plan): Admission {
    const state = this.load();
    return this.allowance(state, plan) > 0
      ? { allowed: true }
      : { allowed: false, retryAfter: this.retryAfter(state) };
  }

  start(plan: Plan): Reservation {
    const state = this.load();
    const remaining = this.allowance(state, plan);
    if (remaining <= 0)
      return { allowed: false, retryAfter: this.retryAfter(state) };
    const timeoutMs = Math.max(
      1,
      Math.min(compilePolicy(plan).timeoutMs, Math.floor(remaining)),
    );
    const id = crypto.randomUUID();
    state.reserved.push({
      id,
      ms: timeoutMs,
      until: this.now() + timeoutMs + 300_000,
    });
    this.storage.write(JSON.stringify(state));
    return { allowed: true, id, timeoutMs };
  }

  finish(id: string, compileMs: number) {
    const state = this.load();
    const run = state.reserved.find((run) => run.id === id);
    if (!run) return;
    state.reserved = state.reserved.filter((run) => run.id !== id);
    this.record(state, this.now(), Math.min(run.ms, Math.max(0, compileMs)));
    this.storage.write(JSON.stringify(state));
  }
}

function fairUseError(userId: string, plan: Plan, retryAfter: number) {
  console.info({
    event: "compile_fair_use_hit",
    telemetryVersion: 1,
    userId,
    plan,
    retryAfter,
  });
  return new HttpError(
    429,
    "You've been compiling frequently. Please try again in a little while.",
    "",
    undefined,
    retryAfter,
  );
}

export function withCompileUsage(
  engine: Engine,
  usageFor: (userId: string) => CompileUsage,
): Engine {
  return async (project, context) => {
    // Jobs accepted before user accounting shipped retain their original plan.
    if (!context.userId) return engine(project, context);
    const usage = usageFor(context.userId);
    const reservation = await usage.start(context.plan);
    if (!reservation.allowed)
      throw fairUseError(context.userId, context.plan, reservation.retryAfter);
    const started = performance.now();
    let chargedMs = 0;
    try {
      const output = await engine(project, {
        ...context,
        timeoutMs: reservation.timeoutMs,
      });
      chargedMs = output.timing.compileMs ?? performance.now() - started;
      return output;
    } catch (error) {
      const compileMs =
        error instanceof HttpError || error instanceof EngineError
          ? error.timing.compileMs
          : null;
      // Without engine timing, elapsed time stands in for a cancelled build or a
      // document that failed. Anything else is our failure and costs nothing.
      const used =
        context.signal?.aborted ||
        (error instanceof HttpError && [408, 422].includes(error.status));
      chargedMs = compileMs ?? (used ? performance.now() - started : 0);
      throw error;
    } finally {
      await usage.finish(reservation.id, chargedMs);
    }
  };
}

export async function checkCompileAdmission(
  request: Request,
  limiter: { limit(options: { key: string }): Promise<{ success: boolean }> },
  usageFor: (userId: string) => CompileUsage,
) {
  const parsed = compileUserSchema.safeParse(
    request.headers.get("X-Compile-User"),
  );
  if (!parsed.success)
    return Response.json(
      { error: "Compile user is required" },
      { status: 400 },
    );
  const userId = parsed.data;
  const plan = planSchema
    .catch("unknown")
    .parse(request.headers.get("X-Compile-Plan"));
  if (!isPaid(plan) && !(await limiter.limit({ key: userId })).success) {
    return Response.json(
      { error: "You're compiling quickly. Please try again in a few seconds." },
      {
        status: 429,
        headers: { "Retry-After": "10", "Cache-Control": "no-store" },
      },
    );
  }
  const admission = await usageFor(userId).check(plan);
  if (!admission.allowed) {
    const error = fairUseError(userId, plan, admission.retryAfter);
    return Response.json(
      { error: error.message },
      {
        status: 429,
        headers: {
          "Retry-After": String(admission.retryAfter),
          "Cache-Control": "no-store",
        },
      },
    );
  }
  return null;
}
