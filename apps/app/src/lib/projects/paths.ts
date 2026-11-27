import { nodeNameSchema } from "@texfolia/contracts";

import {
  InvalidSourcePathError,
  assertSourcePath,
  sourcePathError,
} from "#/lib/storage";

export type ProjectNode = {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  kind: "folder" | "text" | "binary";
};

type PathNode = Pick<ProjectNode, "id" | "parentId" | "name" | "kind">;

export function projectNodePaths(nodes: PathNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots = nodes.filter((node) => node.parentId === null);
  const root =
    roots.length === 1 && roots[0]?.kind === "folder" ? roots[0].id : undefined;
  const paths = new Map<string, string>();
  for (const node of nodes) {
    if (node.id === root) {
      paths.set(node.id, "/");
      continue;
    }
    const segments = [node.name];
    const visited = new Set([node.id]);
    let parent = node.parentId;
    while (parent && parent !== root && !visited.has(parent)) {
      visited.add(parent);
      const folder = byId.get(parent);
      if (!folder) break;
      segments.unshift(folder.name);
      parent = folder.parentId;
    }
    paths.set(node.id, segments.join("/"));
  }
  return paths;
}

export function projectPaths(nodes: PathNode[]) {
  const paths = projectNodePaths(nodes);
  for (const node of nodes) if (node.kind === "folder") paths.delete(node.id);
  return paths;
}

export function newProjectNodePath(
  nodes: PathNode[],
  parentId: string,
  name: string,
) {
  const parsed = nodeNameSchema.safeParse(name);
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid name.");
  const parent = nodes.find(
    (node) => node.id === parentId && node.kind === "folder",
  );
  if (!parent) throw new Error("Folder not found");
  const prefix = projectNodePaths(nodes).get(parentId);
  const path =
    parent.parentId === null ? parsed.data : `${prefix}/${parsed.data}`;
  assertSourcePath(path);
  return path;
}

export function invalidProjectPaths(nodes: PathNode[]) {
  return [...projectNodePaths(nodes)]
    .filter(([, path]) => path !== "/")
    .flatMap(([id, path]) => {
      const error = sourcePathError(path);
      return error ? [{ id, path, error }] : [];
    });
}

export function assertProjectSourcePaths(nodes: PathNode[]) {
  const invalid = invalidProjectPaths(nodes)[0];
  if (invalid)
    throw new InvalidSourcePathError(
      `${JSON.stringify(invalid.path)}: ${invalid.error}`,
    );
}

export function renamedProjectNodes(
  nodes: PathNode[],
  nodeId: string,
  name: string,
  parentId: string,
) {
  const parsed = nodeNameSchema.safeParse(name);
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid name.");
  const node = nodes.find((node) => node.id === nodeId);
  if (!node || node.parentId === null)
    throw new Error("File or folder not found");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parent = byId.get(parentId);
  if (!parent || parent.kind !== "folder") throw new Error("Folder not found");
  const visited = new Set<string>();
  let ancestor: string | null = parentId;
  while (ancestor) {
    if (ancestor === nodeId || visited.has(ancestor))
      throw new Error("Choose a folder outside this item's own subtree.");
    visited.add(ancestor);
    ancestor = byId.get(ancestor)?.parentId ?? null;
  }
  if (
    nodes.some(
      (other) =>
        other.id !== nodeId &&
        other.parentId === parentId &&
        other.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw new Error("A file or folder with this name already exists here.");
  const next = nodes.map((node) =>
    node.id === nodeId ? { ...node, parentId, name: parsed.data } : node,
  );
  const before = projectNodePaths(nodes);
  for (const [id, path] of projectNodePaths(next)) {
    if (path === before.get(id) || path === "/") continue;
    assertSourcePath(path);
  }
  return next;
}
