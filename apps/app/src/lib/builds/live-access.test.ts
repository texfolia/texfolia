import { expect, test } from "bun:test";

import { LiveAccess, liveAccessMs } from "./live-access";

function harness() {
  const allowed = new Set(["ada", "bob"]);
  const state = { checks: 0, now: 0, gate: null as Promise<void> | null };
  const access = new LiveAccess(
    async (userId) => {
      state.checks++;
      await state.gate;
      if (!allowed.has(userId)) throw new Error("Project not found");
    },
    () => state.now,
  );
  return { access, allowed, state };
}
function source() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start: (value) => {
      controller = value;
    },
    cancel: () => {
      cancelled = true;
    },
  });
  return {
    body,
    push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    controller: () => controller,
    cancelled: () => cancelled,
  };
}

test("chunks for an unchanged viewer are checked once, then once per interval", async () => {
  const { access, state } = harness();
  await access.verify("ada");
  const { body, push } = source();
  const reader = access.guard(body, "ada").body.getReader();
  for (let index = 0; index < 640; index++) {
    push(`${index}`);
    await reader.read();
  }
  expect(state.checks).toBe(1);
  state.now += liveAccessMs;
  push("later");
  await reader.read();
  expect(state.checks).toBe(2);
});

test("nothing is delivered after a revocation, even one that has not committed", async () => {
  const { access, allowed, state } = harness();
  await access.verify("ada");
  const { body, push, cancelled } = source();
  let ended = 0;
  const reader = access.guard(body, "ada", () => ended++).body.getReader();
  push("before");
  expect((await reader.read()).value).toBeDefined();
  // The check waits behind the revoking transaction.
  const commit = Promise.withResolvers<void>();
  state.gate = commit.promise;
  access.invalidate(["ada"]);
  push("secret");
  const next = reader.read();
  expect(await Promise.race([next, Bun.sleep(5).then(() => "waiting")])).toBe(
    "waiting",
  );
  allowed.delete("ada");
  commit.resolve();
  expect((await next).done).toBe(true);
  expect(cancelled()).toBe(true);
  expect(ended).toBe(1);
});

test("a revocation during a check discards that check's answer", async () => {
  const { access, state } = harness();
  const first = Promise.withResolvers<void>();
  state.gate = first.promise;
  const verified = access.verify("ada");
  const shared = access.verify("ada");
  access.invalidate(["ada"]);
  state.gate = null;
  first.resolve();
  await Promise.all([verified, shared]);
  expect(state.checks).toBe(2);
  expect(access.fresh("ada")).toBe(true);
});

test("invalidating one viewer leaves the others verified", async () => {
  const { access } = harness();
  await Promise.all([access.verify("ada"), access.verify("bob")]);
  access.invalidate(["ada"]);
  expect([access.fresh("ada"), access.fresh("bob")]).toEqual([false, true]);
  access.invalidate();
  expect(access.fresh("bob")).toBe(false);
});

test("stopping a guarded stream twice, or after its reader left, is safe", async () => {
  const { access } = harness();
  await access.verify("ada");
  const first = source();
  const guarded = access.guard(first.body, "ada");
  const end = guarded.body.getReader().read();
  guarded.stop();
  guarded.stop();
  expect((await end).done).toBe(true);
  const second = source();
  const left = access.guard(second.body, "ada");
  await left.body.cancel();
  left.stop();
  expect(second.cancelled()).toBe(true);
});

test("a body that fails upstream errors instead of looking complete", async () => {
  const { access } = harness();
  await access.verify("ada");
  const { body, controller } = source();
  const reader = access.guard(body, "ada").body.getReader();
  controller().error(new Error("Truncated archive"));
  await expect(reader.read()).rejects.toThrow("Truncated archive");
});
