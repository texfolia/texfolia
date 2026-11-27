import { expect, test } from "bun:test";

import {
  assertProjectSourcePaths,
  invalidProjectPaths,
  newProjectNodePath,
  projectNodePaths,
  projectPaths,
  renamedProjectNodes,
} from "./paths";
import type { ProjectNode } from "./paths";

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

test("invalid paths are detected and rejected before compilation", () => {
  const nodes: Parameters<typeof projectPaths>[0] = [
    root,
    { ...folder, name: "chapters:1" },
    { ...file, name: "intro:1.tex" },
  ];
  expect(invalidProjectPaths(nodes)).toHaveLength(2);
  expect(() => assertProjectSourcePaths(nodes)).toThrow(/colons/);
});

test("folder renames check descendants and enforce source path rules", () => {
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
  expect(() =>
    renamedProjectNodes([root, folder, file], folder.id, "chapters", folder.id),
  ).toThrow(/subtree/);
  expect(() =>
    renamedProjectNodes([root, folder, file], file.id, "intro.tex", file.id),
  ).toThrow(/Folder not found/);
  const moved = renamedProjectNodes(
    [root, folder, file],
    file.id,
    "moved.tex",
    root.id,
  );
  expect(projectPaths(moved).get(file.id)).toBe("moved.tex");
});
