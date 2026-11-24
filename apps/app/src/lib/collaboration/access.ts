import type { Db } from "@texfolia/db";
import { project, projectCollaboration } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";

import type { CollaborationRoom } from "./room";

export type CollaborationAccess = {
  getByName(projectId: string): Pick<CollaborationRoom, "invalidateAccess">;
};

// Rooms cache access, so every path that revokes or changes it must call this.
// Call it before the revoking transaction commits when possible: the room then
// re-verifies behind its locks. A failed call leaves the room's alarm as the
// backstop, which re-verifies connected users every liveProjectAccessIntervalMs.
export async function invalidateCollaborationAccess(
  collaboration: CollaborationAccess | undefined,
  projectId: string,
  userIds?: string[],
) {
  if (!collaboration) return;
  try {
    await collaboration.getByName(projectId).invalidateAccess(userIds);
  } catch (error) {
    console.error("Collaboration access invalidation failed", {
      projectId,
      error,
    });
  }
}

export async function invalidateOrganizationCollaborationAccess({
  db,
  collaboration,
  organizationId,
  userId,
}: {
  db: Db;
  collaboration: CollaborationAccess | undefined;
  organizationId: string;
  userId: string;
}) {
  if (!collaboration) return;
  try {
    // Only registered rooms can hold sockets.
    const rooms = await db
      .select({ projectId: projectCollaboration.projectId })
      .from(projectCollaboration)
      .innerJoin(project, eq(project.id, projectCollaboration.projectId))
      .where(eq(project.organizationId, organizationId));
    await Promise.all(
      rooms.map(({ projectId }) =>
        invalidateCollaborationAccess(collaboration, projectId, [userId]),
      ),
    );
  } catch (error) {
    console.error("Organization collaboration access invalidation failed", {
      organizationId,
      error,
    });
  }
}
