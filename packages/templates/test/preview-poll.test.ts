import { expect, test } from "bun:test";

import { pollTemplatePreviews, queuedTemplatePreviews } from "../src/index";

test("selects at most four queued previews", () => {
  const templates = Array.from({ length: 6 }, (_, index) => ({
    id: String(index),
    previewStatus: index === 0 ? ("ready" as const) : ("queued" as const),
  }));
  expect(queuedTemplatePreviews(templates)).toEqual(["1", "2", "3", "4"]);
  expect(
    queuedTemplatePreviews([{ id: "a", previewStatus: "failed" }]),
  ).toEqual([]);
});

test("refreshes in order and retries after a failure until stopped", async () => {
  const calls: string[] = [];
  let stop = () => {};
  await new Promise<void>((resolve) => {
    stop = pollTemplatePreviews({
      templateIds: ["a", "b"],
      intervalMs: 1,
      refresh: async (id) => {
        calls.push(id);
        if (calls.length === 1) throw new Error("Temporarily unavailable");
      },
      refreshed: async () => {
        calls.push("refreshed");
        resolve();
      },
    });
  });
  stop();
  expect(calls).toEqual(["a", "a", "b", "refreshed"]);
  await Bun.sleep(10);
  expect(calls).toHaveLength(4);
});

test("stopping during a refresh skips the remaining work", async () => {
  const calls: string[] = [];
  const { promise, resolve } = Promise.withResolvers<void>();
  const stop = pollTemplatePreviews({
    templateIds: ["a", "b"],
    intervalMs: 1,
    refresh: async (id) => {
      calls.push(id);
      await promise;
    },
    refreshed: async () => calls.push("refreshed"),
  });
  stop();
  resolve();
  await Bun.sleep(10);
  expect(calls).toEqual(["a"]);
});
