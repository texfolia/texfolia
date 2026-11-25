import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { unknownEngineTiming } from "@texfolia/contracts";

import { collectSinks } from "../../../test/builds/engine";
import { emptyProject } from "../../../test/builds/stores";
import {
  CompileUsageCore,
  compilePolicy,
  rollingWindowMs,
  withCompileUsage,
} from "./limits";
import type { CompileUsage } from "./limits";
import { EngineError, HttpError, MissingSourceError } from "./project";

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE usage (value TEXT NOT NULL)");
  let now = 1_000_000;
  const core = () =>
    new CompileUsageCore(
      {
        read: () =>
          db.query<{ value: string }, []>("SELECT value FROM usage").get()
            ?.value ?? null,
        write: (value) => {
          db.transaction(() => {
            db.exec("DELETE FROM usage");
            db.query("INSERT INTO usage VALUES (?)").run(value);
          })();
        },
      },
      () => now,
    );
  return {
    core,
    advance: (ms: number) => {
      now += ms;
    },
    close: () => db.close(),
  };
}

test("Free, Pro and Team enforce rolling caps and recover after reloading durable state", () => {
  for (const plan of ["free", "pro", "team"] as const) {
    const f = fixture();
    try {
      const policy = compilePolicy(plan);
      for (let used = 0; used < policy.fairUseMs; used += policy.timeoutMs) {
        const run = f.core().start(plan);
        expect(run.allowed).toBe(true);
        if (!run.allowed) throw new Error("Expected admission");
        f.core().finish(run.id, run.timeoutMs);
      }
      expect(f.core().check(plan)).toEqual({
        allowed: false,
        retryAfter: 3600,
      });
      f.advance(rollingWindowMs - 1);
      expect(f.core().check(plan).allowed).toBe(false);
      f.advance(1);
      expect(f.core().check(plan)).toEqual({ allowed: true });
    } finally {
      f.close();
    }
  }
});

test("the window slides from individual completions, without a fixed hourly reset", () => {
  const f = fixture();
  try {
    const first = f.core().start("pro");
    if (!first.allowed) throw new Error("Expected admission");
    f.core().finish(first.id, 300_000);
    f.advance(30 * 60_000);
    const second = f.core().start("pro");
    if (!second.allowed) throw new Error("Expected admission");
    f.core().finish(second.id, 300_000);
    expect(f.core().check("pro")).toEqual({ allowed: false, retryAfter: 1800 });
    f.advance(30 * 60_000);
    const next = f.core().start("pro");
    expect(next.allowed).toBe(true);
    expect(f.core().check("pro").allowed).toBe(false);
  } finally {
    f.close();
  }
});

test("concurrent projects reserve a user's allowance, refund unused time, and recover crashed reservations", () => {
  const f = fixture();
  try {
    const a = f.core().start("pro"),
      b = f.core().start("team");
    if (!a.allowed || !b.allowed) throw new Error("Expected two reservations");
    expect(f.core().start("pro").allowed).toBe(false);
    f.core().finish(a.id, 1000);
    const c = f.core().start("pro");
    expect(c).toMatchObject({ allowed: true, timeoutMs: 299_000 });
    f.advance(600_000);
    expect(f.core().check("pro").allowed).toBe(false);
    f.advance(rollingWindowMs);
    expect(f.core().check("pro").allowed).toBe(true);
  } finally {
    f.close();
  }
});

test("failed engine attempts count toward fair use", async () => {
  const f = fixture();
  try {
    const usage: CompileUsage = {
      async check(plan) {
        return f.core().check(plan);
      },
      async start(plan) {
        return f.core().start(plan);
      },
      async finish(id, ms) {
        f.core().finish(id, ms);
      },
    };
    const engine = withCompileUsage(
      async () => {
        throw new HttpError(408, "Timed out", "", {
          ...unknownEngineTiming,
          compileMs: 300_000,
        });
      },
      () => usage,
    );
    const context = {
      jobId: crypto.randomUUID(),
      userId: "user",
      plan: "pro" as const,
      attempt: 1,
    };
    for (let i = 0; i < 2; i++)
      await expect(
        engine(emptyProject, {
          ...context,
          readSource: async () => new Uint8Array(),
          artifacts: collectSinks().sinks,
        }),
      ).rejects.toThrow("Timed out");
    expect(f.core().check("pro").allowed).toBe(false);
  } finally {
    f.close();
  }
});

test("infrastructure failures cost nothing; cancelled builds and failed documents do", async () => {
  const charged: number[] = [];
  const usage: CompileUsage = {
    check: async () => ({ allowed: true }),
    start: async () => ({ allowed: true, id: "run", timeoutMs: 300_000 }),
    finish: async (_id, ms) => {
      charged.push(ms);
    },
  };
  const run = async (error: unknown, signal?: AbortSignal) => {
    charged.length = 0;
    const engine = withCompileUsage(
      async () => {
        await Bun.sleep(15);
        throw error;
      },
      () => usage,
    );
    await expect(
      engine(emptyProject, {
        jobId: crypto.randomUUID(),
        userId: "user",
        plan: "pro",
        attempt: 1,
        signal,
        readSource: async () => new Uint8Array(),
        artifacts: collectSinks().sinks,
      }),
    ).rejects.toBe(error);
    expect(charged).toHaveLength(1);
    return charged[0]!;
  };
  const timed = { ...unknownEngineTiming, compileMs: 700 };
  expect(await run(new Error("No container"))).toBe(0);
  expect(await run(new EngineError("Lost", unknownEngineTiming))).toBe(0);
  expect(await run(new MissingSourceError())).toBe(0);
  expect(await run(new HttpError(400, "Invalid project sources"))).toBe(0);
  // Time the engine reported is real, whatever failed afterwards.
  expect(await run(new EngineError("Lost", timed))).toBe(700);
  expect(await run(new HttpError(422, "Bad TeX"))).toBeGreaterThan(10);
  expect(
    await run(
      new EngineError("Aborted", unknownEngineTiming),
      AbortSignal.abort(),
    ),
  ).toBeGreaterThan(10);
});

test("reading the allowance writes nothing", () => {
  let saved: string | null = null;
  let writes = 0;
  let now = 1_000_000;
  const core = new CompileUsageCore(
    {
      read: () => saved,
      write: (value) => {
        saved = value;
        writes++;
      },
    },
    () => now,
  );
  const runs = [core.start("pro"), core.start("pro")];
  for (const run of runs) if (run.allowed) core.finish(run.id, 300_000);
  writes = 0;
  expect(core.check("pro").allowed).toBe(false);
  expect(core.start("pro").allowed).toBe(false);
  now += rollingWindowMs;
  expect(core.check("pro").allowed).toBe(true);
  expect(writes).toBe(0);
});

test("paid plans queue ahead of Free, which yields one claim window", () => {
  for (const plan of ["pro", "team"] as const)
    expect(compilePolicy(plan)).toEqual({
      timeoutMs: 300_000,
      fairUseMs: 600_000,
      priority: 1,
      yieldMs: 0,
    });
  for (const plan of ["free", "unknown"] as const)
    expect(compilePolicy(plan)).toEqual({
      timeoutMs: 15_000,
      fairUseMs: 180_000,
      priority: 0,
      yieldMs: 25,
    });
});
