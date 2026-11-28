import { expect, test } from "bun:test";

import { LruCache } from "./lru-cache";

test("drops the least recently used entry over the limit", () => {
  const cache = new LruCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  expect(cache.get("a")).toBe(1);
  cache.set("c", 3);
  expect(cache.size).toBe(2);
  expect(cache.has("b")).toBe(false);
  expect(cache.get("a")).toBe(1);
  expect(cache.get("c")).toBe(3);
});

test("setting an existing key replaces it without evicting another", () => {
  const cache = new LruCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 3);
  expect(cache.get("a")).toBe(3);
  expect(cache.get("b")).toBe(2);
});
