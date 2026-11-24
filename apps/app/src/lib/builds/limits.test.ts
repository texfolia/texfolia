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
import { HttpError } from "./project";

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
