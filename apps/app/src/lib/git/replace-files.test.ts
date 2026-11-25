import { expect, test } from "bun:test";

import {
  planReplacement,
  type GitNode,
  type StoredSource,
} from "./replace-files";

const projectId = "11111111-1111-4111-8111-111111111111";
const at = new Date(1);

function node(
  id: string,
  parentId: string | null,
  name: string,
  objectKey?: string,
): GitNode {
  return {
    id,
    projectId,
    parentId,
    name,
    kind: objectKey ? "text" : "folder",
    objectKey: objectKey ?? null,
    sizeBytes: objectKey ? 1n : 0n,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

const text = (objectKey: string): StoredSource => ({
  objectKey,
  sizeBytes: 1n,
  kind: "text",
});

const nodes = [
  node("root", null, "/"),
  node("main", "root", "main.tex", "k-main"),
  node("chapters", "root", "chapters"),
  node("one", "chapters", "one.tex", "k-one"),
  node("old", "root", "old"),
  node("gone", "old", "gone.tex", "k-gone"),
  node("empty", "root", "empty"),
];

test("leaves unchanged files and folders alone", () => {
  expect(
    planReplacement(
      projectId,
      nodes.filter((n) => !["old", "gone", "empty"].includes(n.id)),
      new Map([
        ["main.tex", text("k-main")],
        ["chapters/one.tex", text("k-one")],
      ]),
    ),
  ).toEqual({ removed: [], created: [], updated: [], retired: [] });
});

test("updates, adds and removes only what differs, in foreign-key order", () => {
  const plan = planReplacement(
    projectId,
    nodes,
    new Map([
      ["main.tex", text("k-new")],
      ["chapters/one.tex", text("k-one")],
      ["a/b/c.tex", text("k-c")],
    ]),
  );
  expect(plan.updated.map(({ id, objectKey }) => [id, objectKey])).toEqual([
    ["main", "k-new"],
  ]);
  expect(plan.removed.map(({ id }) => id).sort()).toEqual([
    "empty",
    "gone",
    "old",
  ]);
  expect(plan.retired.filter(Boolean).sort()).toEqual(["k-gone", "k-main"]);
  const [a, b, c] = plan.created;
  expect(plan.created.map(({ name, kind }) => [name, kind])).toEqual([
    ["a", "folder"],
    ["b", "folder"],
    ["c.tex", "text"],
  ]);
  expect(a?.parentId).toBe("root");
  expect(b?.parentId).toBe(a?.id ?? "");
  expect(c?.parentId).toBe(b?.id ?? "");
});

test("replaces a file with a folder, and a folder with a file", () => {
  const plan = planReplacement(
    projectId,
    nodes,
    new Map([
      ["main.tex/inner.tex", text("k-inner")],
      ["chapters", text("k-file")],
    ]),
  );
  expect(plan.removed.map(({ id }) => id).sort()).toEqual([
    "chapters",
    "empty",
    "gone",
    "main",
    "old",
    "one",
  ]);
  expect(plan.updated).toEqual([]);
  expect(plan.created.map(({ name, kind }) => [name, kind])).toEqual([
    ["main.tex", "folder"],
    ["inner.tex", "text"],
    ["chapters", "text"],
  ]);
});

test("plans 1,000 files without one statement per file", () => {
  const files = new Map(
    Array.from({ length: 1000 }, (_, i) => [
      `d${i % 10}/${i}.tex`,
      text(`${i}`),
    ]),
  );
  const plan = planReplacement(projectId, [node("root", null, "/")], files);
  expect(plan.created).toHaveLength(1010);
});
