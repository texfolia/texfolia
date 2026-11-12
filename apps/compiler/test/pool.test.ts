import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { PoolCore, poolClaimSchema, type PoolClaim } from "../src/pool";

function fixture() {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE state (value TEXT); CREATE TABLE claims (key TEXT PRIMARY KEY, value TEXT)",
  );
  let now = 0;
  let pending: { key: string; claim: PoolClaim } | undefined;
  const running = new Set<string>();
  let failStart = false;
  let beforeStart = async (_name: string) => {};
  const open = () =>
    new PoolCore({
      saved:
        db.query<{ value: string }, []>("SELECT value FROM state").get()
          ?.value ?? null,
      save: (value) =>
        db.transaction(() => {
          if (pending) {
            db.run("INSERT INTO claims VALUES (?, ?)", [
              pending.key,
              JSON.stringify(pending.claim),
            ]);
            pending = undefined;
          }
          db.run("DELETE FROM state");
          db.run("INSERT INTO state VALUES (?)", [value]);
        })(),
      lookup: (key) => {
        const row = db
          .query<{ value: string }, [string]>(
            "SELECT value FROM claims WHERE key = ?",
          )
          .get(key);
        return row ? poolClaimSchema.parse(JSON.parse(row.value)) : undefined;
      },
      assign: (key, claim) => {
        pending = { key, claim };
      },
      start: async (name) => {
        await beforeStart(name);
        if (failStart) throw new Error("capacity");
        running.add(name);
      },
      stop: async (name) => {
        running.delete(name);
      },
      now: () => now,
      pause: () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
  return {
    open,
    running,
    advance: (ms: number) => {
      now += ms;
    },
    fail: (value: boolean) => {
      failStart = value;
    },
    onStart: (fn: typeof beforeStart) => {
      beforeStart = fn;
    },
    close: () => db.close(),
  };
}

describe("prewarmed pool", () => {
  test("Pro wins a scarce spare over an earlier concurrent Free claim", async () => {
    const f = fixture();
    try {
      const pool = f.open();
      await pool.maintain();
      const free = pool.claim("free-project", "free", "1");
      const pro = await pool.claim("pro-project", "pro", "1");
      expect(pro.outcome).toBe("hit");
      expect((await free).outcome).toBe("miss");
      expect(pool.snapshot()).toMatchObject({ hits: 1, misses: 1 });
      expect(await f.open().claim("pro-project", "pro", "1")).toEqual(pro);
      expect(f.open().snapshot()).toMatchObject({ hits: 1, misses: 1 });
      await pool.maintain();
      const other = await pool.claim("other", "free", "1");
      expect(other.outcome).toBe("hit");
      expect(other.container).not.toBe(pro.container);
    } finally {
      f.close();
    }
  });

  test("miss rate grows target, idle hysteresis shrinks only unassigned spares", async () => {
    const f = fixture();
    try {
      const pool = f.open();
      await pool.claim("a", "pro", "1");
      await pool.claim("b", "free", "1");
      f.advance(60_000);
      await pool.maintain();
      expect(pool.snapshot().target).toBe(2);
      expect(f.running.size).toBe(2);
      const owner = await pool.claim("owner", "pro", "1");
      await pool.maintain();
      f.advance(4 * 60_000);
      await pool.maintain();
      expect(pool.snapshot().target).toBe(2);
      f.advance(60_000);
      await pool.maintain();
      expect(pool.snapshot().target).toBe(1);
      expect(pool.snapshot().spares).toHaveLength(1);
      expect(f.running.has(owner.container)).toBe(true);
    } finally {
      f.close();
    }
  });

  test("failed startup is not claimable and recovers with the same identity after eviction", async () => {
    const f = fixture();
    try {
      f.fail(true);
      const pool = f.open();
      await expect(pool.maintain()).rejects.toThrow("capacity");
      const name = pool.snapshot().spares[0]?.name;
      if (!name) throw new Error("Expected persisted warming spare");
      expect((await pool.claim("a", "pro", "1")).outcome).toBe("miss");
      f.fail(false);
      const restored = f.open();
      await restored.maintain();
      expect(await restored.claim("b", "pro", "1")).toEqual({
        outcome: "hit",
        container: name,
      });
    } finally {
      f.close();
    }
  });

  test("a spare claimed during maintenance is never restarted or returned to the pool", async () => {
    const f = fixture();
    try {
      const pool = f.open();
      await pool.claim("a", "pro", "1");
      await pool.claim("b", "pro", "1");
      f.advance(60_000);
      await pool.maintain();
      let claimed: PoolClaim | undefined;
      let starts = 0;
      f.onStart(async () => {
        starts++;
        claimed = await pool.claim("owner", "pro", "1");
      });
      await pool.maintain();
      expect(claimed?.outcome).toBe("hit");
      expect(starts).toBe(1);
      expect(pool.snapshot().spares).toHaveLength(1);
    } finally {
      f.close();
    }
  });
});
