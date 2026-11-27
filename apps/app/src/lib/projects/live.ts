import type { Db } from "@texfolia/db";
import {
  member,
  project,
  projectCollaboration,
  projectCollaborator,
  projectNode,
  projectShareGrant,
  projectTeam,
} from "@texfolia/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { mapLimit } from "#/lib/map-limit";
import { retireSources } from "#/lib/storage/server";

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

// Callers may hold the revoking transaction open, so these stay short.
const retryDelaysMs = [100, 400];

async function invalidate(
  channel: LiveChannel,
  projectId: string,
  userIds?: string[],
) {
  for (let attempt = 0; ; attempt++)
    try {
      // A stub that has thrown may stay broken.
      return await channel.getByName(projectId).invalidateAccess(userIds);
    } catch (error) {
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) {
        console.error("Live project access invalidation failed", {
          projectId,
          error,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
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

/**
 * Tells live channels about projects an account or organization is about to lose
 * or take with it, and queues sources of projects removed by the cascade for
 * garbage collection. Cascades remove the rows that name them, so `before`
 * collects them and `after` notifies and retires. A failure never blocks the
 * deletion.
 */
export function deletionNotice({
  db,
  live,
}: {
  db: Db;
  live: LiveProjects | undefined;
}) {
  // Undefined when everyone loses access, because the project is deleted.
  const affected = new Map<string, string[] | undefined>();
  // Sources of owned projects that the cascade will delete.
  const ownedSources = new Map<string, string[]>();
  return {
    async before(deleted: { userId: string } | { organizationId: string }) {
      affected.clear();
      ownedSources.clear();
      try {
        const ownedIds: string[] = [];
        if ("organizationId" in deleted) {
          for (const { id } of await db
            .select({ id: project.id })
            .from(project)
            .where(eq(project.organizationId, deleted.organizationId))) {
            affected.set(id, undefined);
            ownedIds.push(id);
          }
        } else {
          const { userId } = deleted;
          if (live) {
            for (const { id } of await db
              .select({ id: projectCollaborator.projectId })
              .from(projectCollaborator)
              .where(eq(projectCollaborator.userId, userId)))
              affected.set(id, [userId]);
            for (const { id } of await db
              .select({ id: projectShareGrant.projectId })
              .from(projectShareGrant)
              .where(eq(projectShareGrant.userId, userId)))
              affected.set(id, [userId]);
            for (const { id } of await db
              .select({ id: project.id })
              .from(project)
              .innerJoin(
                member,
                eq(member.organizationId, project.organizationId),
              )
              .where(eq(member.userId, userId)))
              affected.set(id, [userId]);
          }
          for (const { id } of await db
            .select({ id: project.id })
            .from(project)
            .where(eq(project.ownerId, userId))) {
            affected.set(id, undefined);
            ownedIds.push(id);
          }
        }
        if (ownedIds.length) {
          const nodes = await db
            .select({
              projectId: projectNode.projectId,
              objectKey: projectNode.objectKey,
            })
            .from(projectNode)
            .where(
              and(
                inArray(projectNode.projectId, ownedIds),
                isNull(projectNode.deletedAt),
              ),
            );
          for (const node of nodes) {
            if (!node.objectKey) continue;
            const keys = ownedSources.get(node.projectId) ?? [];
            keys.push(node.objectKey);
            ownedSources.set(node.projectId, keys);
          }
        }
      } catch (error) {
        console.error("Deleted projects could not be listed", {
          ...deleted,
          error,
        });
      }
    },
    async after() {
      for (const [projectId, keys] of ownedSources)
        await retireSources(db, projectId, keys).catch((error: unknown) => {
          console.error("Deleted project sources could not be retired", {
            projectId,
            error,
          });
        });
      ownedSources.clear();
      if (live)
        await mapLimit(
          [...affected],
          organizationConcurrency,
          ([id, userIds]) => invalidateProjectAccess(live, id, userIds),
        );
      affected.clear();
    },
  };
}

/**
 * Tells live channels about access that changed with a team: its members, or
 * the team itself. `before` lists the projects shared with the team, because
 * deleting a team cascades to those grants; `after` notifies them.
 */
export function teamAccessNotice({
  db,
  live,
}: {
  db: Db;
  live: LiveProjects | undefined;
}) {
  const affected = new Map<string, string[]>();
  async function projects(teamId: string) {
    return db
      .select({ id: projectTeam.projectId })
      .from(projectTeam)
      .where(eq(projectTeam.teamId, teamId));
  }
  return {
    async before(teamId: string) {
      if (!live) return;
      try {
        affected.set(
          teamId,
          (await projects(teamId)).map(({ id }) => id),
        );
      } catch (error) {
        console.error("Team projects could not be listed", { teamId, error });
      }
    },
    // Everyone re-verifies when `userIds` is undefined.
    async after(teamId: string, userIds?: string[]) {
      if (!live) return;
      try {
        const ids =
          affected.get(teamId) ?? (await projects(teamId)).map(({ id }) => id);
        affected.delete(teamId);
        await mapLimit(ids, organizationConcurrency, (id) =>
          invalidateProjectAccess(live, id, userIds),
        );
      } catch (error) {
        console.error("Team live access invalidation failed", {
          teamId,
          error,
        });
      }
    },
  };
}
