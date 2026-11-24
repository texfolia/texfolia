import type { Db } from "@texfolia/db";
import { project, projectCollaboration } from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import { mapLimit } from "#/lib/map-limit";

// How often a collaboration room re-verifies connected users as a backstop.
export const liveProjectAccessIntervalMs = 5000;

type LiveChannel = {
  getByName(projectId: string): {
    invalidateAccess(userIds?: string[]): Promise<void>;
  };
};
/** Every live channel of a project. Each one caches who may receive its data. */
export type LiveProjects = {
  // Document sockets, in the project's collaboration room.
  collaboration: LiveChannel;
  // Build events and PDF streams, in the project's build coordinator.
  builds: LiveChannel;
};

async function invalidate(
  channel: LiveChannel,
  projectId: string,
  userIds?: string[],
) {
  try {
    await channel.getByName(projectId).invalidateAccess(userIds);
  } catch (error) {
    console.error("Live project access invalidation failed", {
      projectId,
      error,
    });
  }
}

// Live channels cache access, so every path that revokes or changes it must
// call this. Call it before the revoking transaction commits when possible: the
// channel then re-verifies behind its locks. After a failed call the channel's
// own periodic check is the backstop.
export async function invalidateProjectAccess(
  live: LiveProjects | undefined,
  projectId: string,
  userIds?: string[],
) {
  if (!live) return;
  await Promise.all([
    invalidate(live.collaboration, projectId, userIds),
    invalidate(live.builds, projectId, userIds),
  ]);
}

const organizationConcurrency = 10;

export async function invalidateOrganizationAccess({
  db,
  live,
  organizationId,
  userId,
}: {
  db: Db;
  live: LiveProjects | undefined;
  organizationId: string;
  userId: string;
}) {
  if (!live) return;
  try {
    // Only registered rooms can hold document sockets. Builds have no registry.
    const projects = await db
      .select({ id: project.id, room: projectCollaboration.projectId })
      .from(project)
      .leftJoin(
        projectCollaboration,
        eq(projectCollaboration.projectId, project.id),
      )
      .where(
        and(
          eq(project.organizationId, organizationId),
          isNull(project.deletedAt),
        ),
      );
    await mapLimit(projects, organizationConcurrency, async ({ id, room }) => {
      await Promise.all([
        room === null
          ? undefined
          : invalidate(live.collaboration, id, [userId]),
        invalidate(live.builds, id, [userId]),
      ]);
    });
  } catch (error) {
    console.error("Organization live access invalidation failed", {
      organizationId,
      error,
    });
  }
}
