import { expect, test } from "bun:test";

import {
  assertProjectSourcePaths,
  invalidProjectPaths,
  newProjectNodePath,
  projectNodePaths,
  projectPaths,
  renamedProjectNodes,
} from "../src/paths";
import type { ProjectNode } from "../src/paths";

test("files created in nested folders use the same paths in the picker and compiler", () => {
  const nodes: ProjectNode[] = [
    {
      id: "root",
      projectId: "project",
      parentId: null,
      name: "Thesis",
      kind: "folder",
    },
    {
      id: "main",
      projectId: "project",
      parentId: "root",
      name: "main.tex",
      kind: "text",
    },
    {
      id: "chapters",
      projectId: "project",
      parentId: "root",
      name: "chapters",
      kind: "folder",
    },
    {
      id: "intro",
      projectId: "project",
      parentId: "chapters",
      name: "intro.tex",
      kind: "text",
    },
    {
      id: "appendix",
      projectId: "project",
      parentId: "root",
      name: "appendix",
      kind: "folder",
    },
    {
      id: "nested",
      projectId: "project",
      parentId: "appendix",
      name: "chapters",
      kind: "folder",
    },
  ];
  expect([...projectPaths(nodes)]).toEqual([
    ["main", "main.tex"],
    ["intro", "chapters/intro.tex"],
  ]);
  const picker = projectNodePaths(nodes);
  expect(picker.get("root")).toBe("/");
  expect(picker.get("chapters")).toBe("chapters");
  expect(picker.get("nested")).toBe("appendix/chapters");
});

const root = {
  id: "root",
  parentId: null,
  name: "A project: not part of source paths",
  kind: "folder",
} satisfies Parameters<typeof projectPaths>[0][number];
const folder = {
  id: "folder",
  parentId: "root",
  name: "chapters",
  kind: "folder",
} satisfies Parameters<typeof projectPaths>[0][number];
const file = {
  id: "file",
  parentId: "folder",
  name: "intro.tex",
  kind: "text",
} satisfies Parameters<typeof projectPaths>[0][number];

test("creation checks assembled paths, UTF-8 lengths, and reserved roots", () => {
  const nodes = [root, folder];
  expect(newProjectNodePath(nodes, folder.id, "a".repeat(231))).toHaveLength(
    240,
  );
  expect(() => newProjectNodePath(nodes, folder.id, "a".repeat(232))).toThrow(
    /240 UTF-8 bytes/,
  );
  expect(newProjectNodePath(nodes, folder.id, "é".repeat(115))).toBe(
    `chapters/${"é".repeat(115)}`,
  );
  expect(() => newProjectNodePath(nodes, folder.id, "é".repeat(116))).toThrow(
    /240 UTF-8 bytes/,
  );
  for (const name of ["out", "OUT", "Out"])
    expect(() => newProjectNodePath(nodes, root.id, name)).toThrow(/reserved/);
  expect(newProjectNodePath(nodes, folder.id, "out")).toBe("chapters/out");
  expect(() => newProjectNodePath(nodes, folder.id, "chapter:1.tex")).toThrow(
    /colons/,
  );
});

test("legacy names can be repaired one at a time while preserving ids and tree", () => {
  let nodes: Parameters<typeof projectPaths>[0] = [
    root,
    { ...folder, name: "chapters:1" },
    { ...file, name: "intro:1.tex" },
  ];
  expect(invalidProjectPaths(nodes)).toHaveLength(2);
  expect(() => assertProjectSourcePaths(nodes)).toThrow(/Repair source paths/);
  nodes = renamedProjectNodes(nodes, folder.id, "chapters", root.id);
  expect(invalidProjectPaths(nodes)).toHaveLength(1);
  nodes = renamedProjectNodes(nodes, file.id, "intro.tex", folder.id);
  expect(invalidProjectPaths(nodes)).toHaveLength(0);
  expect(nodes).toEqual([root, folder, file]);
});

test("folder renames check descendants and permit incremental shortening of legacy paths", () => {
  const nodes = [
    root,
    { ...folder, name: "a".repeat(230) },
    { ...file, name: "b".repeat(20) },
  ];
  expect(() =>
    renamedProjectNodes(nodes, folder.id, "c".repeat(231), root.id),
  ).toThrow(/240 UTF-8 bytes/);
  let repaired = renamedProjectNodes(
    nodes,
    folder.id,
    "a".repeat(225),
    root.id,
  );
  expect(invalidProjectPaths(repaired)).toHaveLength(1);
  repaired = renamedProjectNodes(repaired, file.id, "intro.tex", folder.id);
  expect(invalidProjectPaths(repaired)).toHaveLength(0);
  const valid = [root, folder, { ...file, name: "a".repeat(230) }];
  expect(() =>
    renamedProjectNodes(valid, folder.id, "long-chapters", root.id),
  ).toThrow(/240 UTF-8 bytes/);
  expect(() =>
    renamedProjectNodes([root, folder, file], folder.id, "out", root.id),
  ).toThrow(/reserved/);
  expect(() =>
    renamedProjectNodes([root, folder, file], root.id, "renamed", root.id),
  ).toThrow(/not found/);
});

test("deep legacy paths can move closer to the root without changing ids", () => {
  const folders: Parameters<typeof projectPaths>[0] = Array.from(
    { length: 121 },
    (_, i) => ({
      id: `folder-${i}`,
      parentId: i === 0 ? root.id : `folder-${i - 1}`,
      name: "a",
      kind: "folder",
    }),
  );
  const nested = { ...file, parentId: "folder-120" };
  const nodes = [root, ...folders, nested];
  expect(invalidProjectPaths(nodes).length).toBeGreaterThan(0);
  const repaired = renamedProjectNodes(
    nodes,
    "folder-120",
    "recovered",
    root.id,
  );
  expect(invalidProjectPaths(repaired)).toHaveLength(0);
  expect(projectPaths(repaired).get(file.id)).toBe("recovered/intro.tex");
  expect(() =>
    renamedProjectNodes([root, folder, file], folder.id, "chapters", folder.id),
  ).toThrow(/subtree/);
  expect(() =>
    renamedProjectNodes([root, folder, file], file.id, "intro.tex", file.id),
  ).toThrow(/Folder not found/);
});
