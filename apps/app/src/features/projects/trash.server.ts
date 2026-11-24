import type { Db } from "@texfolia/db";
import { project, projectNode, user } from "@texfolia/db/schema";
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";

import { isOrgAdmin } from "#/features/auth/roles";
import { retireSources } from "#/features/storage/server";

import {
  availableProjectName,
  requireProjectManager,
  type LockProject,
  type ProjectTransaction,
} from "./access";
import { trashRetentionDays } from "./project.schema";

// `project.deletedAt` means the project is in the trash. It cannot be opened,
// but its row, sources, collaboration documents, and Git clone stay until the
// row is deleted, so storage cleanup keys on the row and not on `deletedAt`.

type ProjectRequest = { db: Db; userId: string; projectId: string };

const trashRetentionMs = trashRetentionDays * 24 * 60 * 60 * 1000;

// Moves the project to the trash. Closing collaboration sockets and clearing
// builds are the caller's: run them after this resolves.
export async function trashProject({
  db,
  userId,
  projectId,
  lock,
}: ProjectRequest & { lock: LockProject }) {
  await db.transaction(async (tx) => {
    const found = await lock({ tx, projectId, userId });
    await requireProjectManager(tx, found, userId);
    await tx
      .update(project)
      .set({ deletedAt: new Date() })
      .where(eq(project.id, projectId));
  });
}

async function lockTrashedProject(
  tx: ProjectTransaction,
  { projectId, userId }: Omit<ProjectRequest, "db">,
) {
  const [found] = await tx
    .select()
    .from(project)
    .where(and(eq(project.id, projectId), isNotNull(project.deletedAt)))
    .for("update");
  if (!found) throw new Error("Project not found");
  await requireProjectManager(tx, found, userId);
  return found;
}

// Returns the project to its owner with its collaborators, share links,
// comments, and Git link. A taken personal name gets a numeric suffix.
export async function restoreProject({
  db,
  userId,
  projectId,
}: ProjectRequest) {
  return db.transaction(async (tx) => {
    // Lock the user before the project, as every name allocation does.
    await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    const found = await lockTrashedProject(tx, { projectId, userId });
    const name = found.ownerId
      ? await availableProjectName(tx, { ownerId: found.ownerId }, found.name)
      : found.name;
    await tx
      .update(project)
      .set({ deletedAt: null, name })
      .where(eq(project.id, projectId));
    return { id: projectId, name };
  });
}

// Deletes the row, which cascades to everything stored with it, and queues the
// sources for collection.
async function removeProject(tx: ProjectTransaction, projectId: string) {
  const sources = await tx
    .select({ key: projectNode.objectKey })
    .from(projectNode)
    .where(
      and(eq(projectNode.projectId, projectId), isNull(projectNode.deletedAt)),
    );
  await retireSources(
    tx,
    projectId,
    sources.map((source) => source.key),
  );
  await tx.delete(project).where(eq(project.id, projectId));
}

// Permanently deletes a project that is in the trash. Collaboration and Git
// objects are the caller's to clean up after this resolves.
export async function deleteTrashedProject({
  db,
  userId,
  projectId,
}: ProjectRequest) {
  await db.transaction(async (tx) => {
    await lockTrashedProject(tx, { projectId, userId });
    await removeProject(tx, projectId);
  });
}

// Permanently deletes projects whose time in the trash has run out, and returns
// the IDs it deleted. One failing project does not hold up the rest; the next
// run retries it.
export async function deleteExpiredProjects({ db }: { db: Db }) {
  const expired = and(
    isNotNull(project.deletedAt),
    lte(project.deletedAt, new Date(Date.now() - trashRetentionMs)),
  );
  const candidates = await db
    .select({ id: project.id })
    .from(project)
    .where(expired);
  const deleted: string[] = [];
  for (const { id } of candidates)
    try {
      const removed = await db.transaction(async (tx) => {
        // The project may have been restored since it was listed.
        const [found] = await tx
          .select({ id: project.id })
          .from(project)
          .where(and(eq(project.id, id), expired))
          .for("update");
        if (found) await removeProject(tx, id);
        return Boolean(found);
      });
      if (removed) deleted.push(id);
    } catch (error) {
      console.error("Expired project deletion failed", {
        projectId: id,
        error,
      });
    }
  return deleted;
}

// Trashed projects the viewer may restore or permanently delete, most recently
// trashed first.
export async function getTrashedProjects({
  db,
  userId,
}: {
  db: Db;
  userId: string;
}) {
  const rows = await db.query.project.findMany({
    columns: { id: true, name: true, deletedAt: true },
    with: {
      organization: {
        columns: { name: true },
        with: {
          members: { columns: { role: true }, where: { userId } },
        },
      },
    },
    where: {
      deletedAt: { isNotNull: true },
      OR: [
        { organizationId: { isNull: true }, ownerId: userId },
        { organization: { members: { userId } } },
      ],
    },
    orderBy: { deletedAt: "desc", id: "desc" },
  });
  return rows.flatMap(({ id, name, deletedAt, organization }) =>
    deletedAt &&
    (!organization ||
      organization.members.some((membership) => isOrgAdmin(membership.role)))
      ? [
          {
            id,
            name,
            organizationName: organization?.name ?? null,
            deletedAt,
            expiresAt: new Date(deletedAt.getTime() + trashRetentionMs),
          },
        ]
      : [],
  );
}
