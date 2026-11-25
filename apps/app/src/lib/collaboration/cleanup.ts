import type { Db } from "@texfolia/db";
import { project, projectCollaboration } from "@texfolia/db/schema";
import { and, asc, eq, gt, isNotNull, or, sql } from "drizzle-orm";

import type { CollaborationRoom } from "./room";

const projectGone = sql`NOT EXISTS (SELECT 1 FROM ${project} WHERE ${project.id} = ${projectCollaboration.projectId})`;

// Records that a room holds documents of deleted files, in the transaction that
// deletes them. The room clears it once they are gone.
export async function requestCollaborationCleanup(
  tx: Pick<Db, "update">,
  projectId: string,
) {
  await tx
    .update(projectCollaboration)
    .set({ cleanupRequestedAt: new Date() })
    .where(eq(projectCollaboration.projectId, projectId));
}

export type CollaborationCleanup = {
  getByName(projectId: string): Pick<CollaborationRoom, "purgeDeletedSources">;
};

export async function cleanupDeletedCollaboration(
  collaboration: CollaborationCleanup | undefined,
  projectId: string,
) {
  if (!collaboration) return;
  try {
    await collaboration.getByName(projectId).purgeDeletedSources(projectId);
  } catch (error) {
    // The request, or the registration of a deleted project, remains until a
    // scheduled sweep reaches the room.
    console.error("Deleted source collaboration cleanup failed", {
      projectId,
      error,
    });
  }
}

// Reaches the rooms that a deletion could not. Every other room is left asleep.
export async function collectCollaborationSources({
  db,
  collaboration,
}: {
  db: Db;
  collaboration?: CollaborationCleanup;
}) {
  let cursor: string | undefined;
  const failures: unknown[] = [];
  for (;;) {
    const rooms = await db
      .select({ projectId: projectCollaboration.projectId })
      .from(projectCollaboration)
      .where(
        and(
          cursor ? gt(projectCollaboration.projectId, cursor) : undefined,
          or(isNotNull(projectCollaboration.cleanupRequestedAt), projectGone),
        ),
      )
      .orderBy(asc(projectCollaboration.projectId))
      .limit(100);
    if (!rooms.length) break;
    if (!collaboration)
      throw new Error("Collaboration cleanup binding required");
    for (const { projectId } of rooms) {
      cursor = projectId;
      try {
        // Never hold a project lock across RPC: an in-flight source flush needs it.
        const { projectDeleted } = await collaboration
          .getByName(projectId)
          .purgeDeletedSources(projectId);
        // A project deleted after the DO's read still needs another sweep.
        if (projectDeleted)
          await db
            .delete(projectCollaboration)
            .where(
              and(eq(projectCollaboration.projectId, projectId), projectGone),
            );
      } catch (error) {
        console.error("Collaborative source collection failed", {
          projectId,
          error,
        });
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Collaboration cleanup failed");
}
