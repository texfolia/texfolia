import { expect, test } from "bun:test";

import { projectNodePaths, projectPaths } from "#/lib/project-paths";
import type { ProjectNode } from "#/lib/project.functions";

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
