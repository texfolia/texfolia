import { afterEach, expect, test } from "bun:test";

import { createLiveQueryCollection } from "@tanstack/react-db";

import { createRpcCollection } from "./rpc-collection";

type Row = { id: string; name: string };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("a new row appears optimistically and settles to the server's canonical value", async () => {
  const response = Promise.withResolvers<Row>();
  const rows = createRpcCollection<Row>({
    initial: [],
    insert: () => response.promise,
  });
  const view = createLiveQueryCollection({
    query: (q) => q.from({ row: rows }),
  });
  cleanups.push(
    () => view.cleanup(),
    () => rows.cleanup(),
  );
  await view.preload();
  const transaction = rows.insert({ id: "chapter", name: "draft.tex" });
  expect(rows.get("chapter")?.name).toBe("draft.tex");
  expect(view.toArray.map((row) => row.name)).toEqual(["draft.tex"]);
  response.resolve({ id: "chapter", name: "chapter.tex" });
  await transaction.when("settled");
  expect(rows.get("chapter")?.name).toBe("chapter.tex");
  expect(view.toArray.map((row) => row.name)).toEqual(["chapter.tex"]);
});

test("a rejected insert is removed from the live query", async () => {
  const response = Promise.withResolvers<Row>();
  const rows = createRpcCollection<Row>({
    initial: [],
    insert: () => response.promise,
  });
  cleanups.push(() => rows.cleanup());
  const transaction = rows.insert({ id: "chapter", name: "duplicate.tex" });
  response.reject(new Error("duplicate"));
  await expect(transaction.when("settled")).rejects.toThrow("duplicate");
  expect(rows.has("chapter")).toBe(false);
});

test("deletion rolls back on failure and stays removed after acknowledgement", async () => {
  const response = Promise.withResolvers<void>();
  const rows = createRpcCollection<Row>({
    initial: [{ id: "project", name: "Thesis" }],
    insert: async (row) => row,
    remove: () => response.promise,
  });
  cleanups.push(() => rows.cleanup());
  const transaction = rows.delete("project");
  expect(rows.has("project")).toBe(false);
  response.reject(new Error("offline"));
  await expect(transaction.when("settled")).rejects.toThrow("offline");
  expect(rows.get("project")?.name).toBe("Thesis");

  const confirmed = createRpcCollection<Row>({
    initial: rows.toArray,
    insert: async (row) => row,
    remove: async () => {},
  });
  cleanups.push(() => confirmed.cleanup());
  await confirmed.delete("project").when("settled");
  expect(confirmed.has("project")).toBe(false);
});

test("collections created for different route owners do not share rows", async () => {
  const first = createRpcCollection<Row>({
    initial: [{ id: "private", name: "Thesis" }],
    insert: async (row) => row,
  });
  const second = createRpcCollection<Row>({
    initial: [],
    insert: async (row) => row,
  });
  cleanups.push(
    () => first.cleanup(),
    () => second.cleanup(),
  );
  await first.insert({ id: "new", name: "Paper" }).when("settled");
  expect(second.toArray).toEqual([]);
});

test("bulk writes are rejected before any partial server changes", async () => {
  const persisted: Row[] = [];
  const rows = createRpcCollection<Row>({
    initial: [],
    insert: async (row) => {
      persisted.push(row);
      return row;
    },
  });
  cleanups.push(() => rows.cleanup());
  await expect(
    rows
      .insert([
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ])
      .when("settled"),
  ).rejects.toThrow("one row");
  expect(persisted).toEqual([]);
  expect(rows.toArray).toEqual([]);
});

test("remote snapshots reconcile a live query without losing optimistic writes", async () => {
  const response = Promise.withResolvers<Row>();
  const rows = createRpcCollection<Row>({
    initial: [{ id: "old", name: "old.tex" }],
    insert: () => response.promise,
  });
  const view = createLiveQueryCollection({
    query: (q) => q.from({ row: rows }),
  });
  cleanups.push(
    () => view.cleanup(),
    () => rows.cleanup(),
  );
  await view.preload();
  const transaction = rows.insert({ id: "local", name: "draft.tex" });
  rows.utils.replace([{ id: "remote", name: "chapter.tex" }]);
  expect(rows.has("local")).toBe(true);
  response.resolve({ id: "local", name: "draft.tex" });
  await transaction.when("settled");
  expect(view.toArray.map((row) => row.name).sort()).toEqual([
    "chapter.tex",
    "draft.tex",
  ]);
  expect(rows.has("old")).toBe(false);
});
