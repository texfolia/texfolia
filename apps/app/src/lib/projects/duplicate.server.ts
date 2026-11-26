import type { Db } from "@texfolia/db";
import { project, projectNode, user } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";

import { mapLimit } from "#/lib/map-limit";
import {
  copySource,
  sourceConcurrency,
  type SourceBucket,
} from "#/lib/storage/server";

import { availableProjectName, type LockProject } from "./access";

// Copies a readable project's saved sources, main document, formatting, and
// spelling settings into a new personal project. Collaborators, share links, comments, chats,
// tags, the Git remote, and builds stay with the original.
export async function duplicateProject({
  db,
  bucket,
  userId,
  projectId,
  lock,
}: {
  db: Db;
  bucket: SourceBucket;
  userId: string;
  projectId: string;
  lock: LockProject;
}) {
  const { source, nodes } = await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId));
    if (!owner) throw new Error("Project not found");
    const source = await lock({ tx, projectId, userId, access: "read" });
    if (source.guest) throw new Error("Project not found");
    const nodes = await tx.query.projectNode.findMany({
      where: { projectId, deletedAt: { isNull: true } },
    });
    return { source, nodes };
  });
  const id = crypto.randomUUID();
  // Nodes with the same content share an object, so copy each one once.
  const sizes = new Map<string, bigint>();
  for (const node of nodes)
    if (node.objectKey) sizes.set(node.objectKey, node.sizeBytes);
  const keys = new Map(
    await mapLimit(
      [...sizes],
      sourceConcurrency,
      async ([from, sizeBytes]) =>
        [
          from,
          await copySource({
            bucket,
            from,
            to: `projects/${id}/sources`,
            sizeBytes: Number(sizeBytes),
          }),
        ] as const,
    ),
  );
  const ids = new Map(nodes.map((node) => [node.id, crypto.randomUUID()]));
  const copies = nodes.map((node) => {
    const copyId = ids.get(node.id);
    const parentId = node.parentId ? ids.get(node.parentId) : null;
    if (!copyId || parentId === undefined)
      throw new Error("Invalid project tree");
    return {
      id: copyId,
      projectId: id,
      parentId,
      name: node.name,
      kind: node.kind,
      objectKey: node.objectKey ? keys.get(node.objectKey) : null,
      sizeBytes: node.sizeBytes,
    };
  });
  return db.transaction(async (tx) => {
    // Every name allocation locks the owner's row first.
    await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    const name = await availableProjectName(
      tx,
      { ownerId: userId },
      `${source.name} copy`,
    );
    await tx.insert(project).values({
      id,
      ownerId: userId,
      name,
      formatIndent: source.formatIndent,
      formatWrap: source.formatWrap,
      formatWidth: source.formatWidth,
      spellcheckLanguage: source.spellcheckLanguage,
      mainFile: source.mainFile,
    });
    if (copies.length) await tx.insert(projectNode).values(copies);
    return { id, name };
  });
}
