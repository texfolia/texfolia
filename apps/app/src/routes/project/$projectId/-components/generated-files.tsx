import { type BuildSnapshot } from "@texfolia/contracts";

import type { ProjectNode } from "#/lib/projects/project.functions";

export function generatedTreeNodes(
  build: BuildSnapshot | null,
  rootId: string | undefined,
): ProjectNode[] {
  if (!rootId || !build?.artifacts) return [];
  const nodes = new Map<string, ProjectNode>();
  nodes.set("out:", {
    id: "out:",
    projectId: "out",
    parentId: rootId,
    name: "out",
    kind: "folder",
  });
  for (const file of build.artifacts.files) {
    const parts = file.path.split("/");
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join("/");
      nodes.set(`out:${path}`, {
        id: `out:${path}`,
        projectId: "out",
        parentId: index ? `out:${parts.slice(0, index).join("/")}` : "out:",
        name: parts[index] ?? path,
        kind: index === parts.length - 1 ? "binary" : "folder",
      });
    }
  }
  return [...nodes.values()];
}
