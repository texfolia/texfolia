import type { Db } from "@texfolia/db";
import { project, projectCollaboration } from "@texfolia/db/schema";
import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { CollaborationRoom } from "./room";

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
    // The room registration remains until a scheduled sweep acknowledges cleanup.
    console.error("Deleted source collaboration cleanup failed", {
      projectId,
      error,
    });
  }
}

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
      .select()
      .from(projectCollaboration)
      .where(cursor ? gt(projectCollaboration.projectId, cursor) : undefined)
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
              and(
                eq(projectCollaboration.projectId, projectId),
                sql`NOT EXISTS (SELECT 1 FROM ${project} WHERE ${project.id} = ${projectId} AND ${project.deletedAt} IS NULL)`,
              ),
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
