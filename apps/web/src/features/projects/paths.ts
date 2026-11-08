import type { ProjectNode } from "./collections";

export function projectNodePaths(nodes: ProjectNode[]) {
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

export function projectPaths(nodes: ProjectNode[]) {
  const paths = projectNodePaths(nodes);
  for (const node of nodes) if (node.kind === "folder") paths.delete(node.id);
  return paths;
}
