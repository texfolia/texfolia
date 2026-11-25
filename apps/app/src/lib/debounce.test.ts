import { expect, test } from "bun:test";

import { debounce } from "./debounce";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("runs only the last call after scheduling pauses", async () => {
  const calls: number[] = [];
  const debounced = debounce((value: number) => calls.push(value), 20);
  for (const value of [1, 2, 3]) debounced.schedule(value);
  expect(calls).toEqual([]);
  await wait(40);
  expect(calls).toEqual([3]);
});

test("flushes a waiting call once, and nothing when none waits", async () => {
  const calls: number[] = [];
  const debounced = debounce((value: number) => calls.push(value), 10);
  debounced.flush();
  debounced.schedule(1);
  debounced.flush();
  await wait(30);
  expect(calls).toEqual([1]);
});

test("cancels a waiting call", async () => {
  const calls: number[] = [];
  const debounced = debounce((value: number) => calls.push(value), 10);
  debounced.schedule(1);
  debounced.cancel();
  debounced.flush();
  await wait(30);
  expect(calls).toEqual([]);
});
