import { project, projectNode } from "@texfolia/db/schema";
import { eq, inArray, sql } from "drizzle-orm";

import { requestCollaborationCleanup } from "#/lib/collaboration/server";
import { projectNodePaths } from "#/lib/projects";
import type { ProjectTransaction } from "#/lib/projects/server";
import { retireSources } from "#/lib/storage/server";

export type GitNode = typeof projectNode.$inferSelect;

/** A file's stored content. */
export type StoredSource = {
  objectKey: string | null;
  sizeBytes: bigint;
  kind: "text" | "binary";
};

/**
 * What has to change for a project to hold exactly `files`. Nodes whose path
 * stays keep their ID, so open Yjs rooms keep their identity, and unchanged ones
 * are left alone.
 */
export function planReplacement(
  projectId: string,
  nodes: GitNode[],
  files: ReadonlyMap<string, StoredSource>,
) {
  const root = nodes.find(
    (node) => node.parentId === null && node.kind === "folder",
  );
  if (!root) throw new Error("Project root is missing.");
  const folders = new Set<string>();
  for (const path of files.keys())
    for (
      let at = path.lastIndexOf("/");
      at > 0;
      at = path.lastIndexOf("/", at - 1)
    )
      folders.add(path.slice(0, at));
  const paths = projectNodePaths(nodes);
  const kept = new Map<string, GitNode>([["", root]]);
  const removed: GitNode[] = [];
  for (const node of nodes) {
    if (node.id === root.id) continue;
    const path = paths.get(node.id) ?? "";
    if (node.kind === "folder" ? folders.has(path) : files.has(path))
      kept.set(path, node);
    else removed.push(node);
  }
  type Row = Pick<
    GitNode,
    | "id"
    | "projectId"
    | "parentId"
    | "name"
    | "kind"
    | "objectKey"
    | "sizeBytes"
  >;
  const created: Row[] = [];
  const updated: Row[] = [];
  const retired = removed.map((node) => node.objectKey);
  const ids = new Map([...kept].map(([path, node]) => [path, node.id]));
  const place = (path: string) => {
    const at = path.lastIndexOf("/");
    const parentId = ids.get(path.slice(0, Math.max(at, 0)));
    const name = path.slice(at + 1);
    if (!parentId || !name) throw new Error("Invalid git file name");
    return { projectId, parentId, name };
  };
  // Shorter paths first, so every folder follows the one it is in.
  for (const path of [...folders].sort((a, b) => a.length - b.length)) {
    if (ids.has(path)) continue;
    const id = crypto.randomUUID();
    created.push({
      id,
      ...place(path),
      kind: "folder",
      objectKey: null,
      sizeBytes: 0n,
    });
    ids.set(path, id);
  }
  for (const [path, source] of files) {
    const existing = kept.get(path);
    if (!existing)
      created.push({ id: crypto.randomUUID(), ...place(path), ...source });
    else if (
      existing.objectKey !== source.objectKey ||
      existing.kind !== source.kind
    ) {
      updated.push({ id: existing.id, ...place(path), ...source });
      if (existing.objectKey !== source.objectKey)
        retired.push(existing.objectKey);
    }
  }
  return { removed, created, updated, retired };
}

// Below PostgreSQL's limit of 65,535 parameters per statement.
const rowsPerStatement = 1000;

function* batches<T>(rows: T[]) {
  for (let start = 0; start < rows.length; start += rowsPerStatement)
    yield rows.slice(start, start + rowsPerStatement);
}

/** Points a locked project at `files`, whose objects are stored already. */
export async function replaceFiles(
  tx: ProjectTransaction,
  projectId: string,
  nodes: GitNode[],
  files: ReadonlyMap<string, StoredSource>,
) {
  const { removed, created, updated, retired } = planReplacement(
    projectId,
    nodes,
    files,
  );
  const updatedAt = new Date();
  await retireSources(tx, projectId, retired);
  if (removed.length) {
    await requestCollaborationCleanup(tx, projectId);
    for (const batch of batches(removed))
      await tx
        .update(projectNode)
        .set({ deletedAt: updatedAt, updatedAt })
        .where(
          inArray(
            projectNode.id,
            batch.map((node) => node.id),
          ),
        );
  }
  for (const batch of batches(created))
    await tx
      .insert(projectNode)
      .values(batch.map((row) => ({ ...row, updatedAt })));
  for (const batch of batches(updated))
    await tx
      .insert(projectNode)
      .values(batch.map((row) => ({ ...row, updatedAt })))
      .onConflictDoUpdate({
        target: projectNode.id,
        set: {
          kind: sql`excluded.kind`,
          objectKey: sql`excluded.object_key`,
          sizeBytes: sql`excluded.size_bytes`,
          updatedAt,
        },
      });
  await tx.update(project).set({ updatedAt }).where(eq(project.id, projectId));
}
