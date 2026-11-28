import type { Db } from "@texfolia/db";
import {
  member,
  projectCollaborator,
  projectShareGrant,
  projectShareLink,
  projectTeam,
  teamMember,
  user,
} from "@texfolia/db/schema";
import { and, eq, inArray } from "drizzle-orm";

import { isOrgAdmin } from "#/lib/auth/roles";
import type { ProjectRow, ProjectTransaction } from "#/lib/projects/server";
import {
  lockProject,
  shareLinkIdOf,
} from "#/lib/sharing/project-access.server";

import type { MentionCandidate, ResolvedMention } from "./tokens";

export type AccessibleProjectPerson = MentionCandidate & {
  email: string;
};

/**
 * Collects every signed-in account that currently has access to `found`:
 * the personal owner, direct collaborators (scoped to org members on org
 * projects), org owners/admins, org members when `organizationRole` is set,
 * team members granted access, and signed-in users who redeemed a share link.
 * Anonymous share-link guests have no user account and are never included.
 */
export async function listProjectAccessiblePeople(
  tx: ProjectTransaction,
  found: Pick<
    ProjectRow,
    "id" | "ownerId" | "organizationId" | "organizationRole"
  >,
): Promise<Map<string, AccessibleProjectPerson>> {
  const people = new Map<string, AccessibleProjectPerson>();
  const add = (row: AccessibleProjectPerson) => {
    if (!people.has(row.id)) people.set(row.id, row);
  };

  if (found.ownerId) {
    const [owner] = await tx
      .select({
        id: user.id,
        name: user.name,
        image: user.image,
        email: user.email,
      })
      .from(user)
      .where(eq(user.id, found.ownerId))
      .limit(1);
    if (owner) add(owner);
  }

  const collaboratorsQuery = tx
    .select({
      id: user.id,
      name: user.name,
      image: user.image,
      email: user.email,
    })
    .from(projectCollaborator)
    .innerJoin(user, eq(user.id, projectCollaborator.userId));

  const collaborators = await (
    found.organizationId
      ? collaboratorsQuery.innerJoin(
          member,
          and(
            eq(member.userId, projectCollaborator.userId),
            eq(member.organizationId, found.organizationId),
          ),
        )
      : collaboratorsQuery
  ).where(eq(projectCollaborator.projectId, found.id));
  for (const row of collaborators) add(row);

  if (found.organizationId) {
    const orgMembers = await tx
      .select({
        id: user.id,
        name: user.name,
        image: user.image,
        email: user.email,
        role: member.role,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, found.organizationId));
    for (const row of orgMembers) {
      if (found.organizationRole !== null || isOrgAdmin(row.role)) {
        add({
          id: row.id,
          name: row.name,
          image: row.image,
          email: row.email,
        });
      }
    }

    const teamPeople = await tx
      .select({
        id: user.id,
        name: user.name,
        image: user.image,
        email: user.email,
      })
      .from(projectTeam)
      .innerJoin(teamMember, eq(teamMember.teamId, projectTeam.teamId))
      .innerJoin(
        member,
        and(
          eq(member.userId, teamMember.userId),
          eq(member.organizationId, found.organizationId),
        ),
      )
      .innerJoin(user, eq(user.id, teamMember.userId))
      .where(eq(projectTeam.projectId, found.id));
    for (const row of teamPeople) add(row);
  }

  const shareGrants = await tx
    .select({
      id: user.id,
      name: user.name,
      image: user.image,
      email: user.email,
    })
    .from(projectShareGrant)
    .innerJoin(
      projectShareLink,
      eq(projectShareLink.id, projectShareGrant.linkId),
    )
    .innerJoin(user, eq(user.id, projectShareGrant.userId))
    .where(
      and(
        eq(projectShareGrant.projectId, found.id),
        eq(projectShareLink.projectId, found.id),
      ),
    );
  for (const row of shareGrants) add(row);

  return people;
}

/**
 * Lists mentionable people for a project. Emails are intentionally omitted so
 * non-managers never see collaborator email addresses in the mention picker.
 */
export async function listProjectMentionCandidates({
  db,
  userId,
  projectId,
}: {
  db: Db;
  userId: string;
  projectId: string;
}): Promise<{ people: MentionCandidate[] }> {
  if (shareLinkIdOf(userId) !== null) throw new Error("Project not found");
  return db.transaction(async (tx) => {
    const found = await lockProject({ tx, projectId, userId, access: "read" });
    const accessible = await listProjectAccessiblePeople(tx, found);
    const people = [...accessible.values()]
      .map(({ id, name, image }) => ({ id, name, image }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { people };
  });
}

/**
 * Resolves mentioned user IDs to current profiles for active project members,
 * or safe historical labels ("Former collaborator" / "Deleted user") for
 * people who lost access or deleted their accounts.
 */
export async function resolveProjectMentions(
  tx: ProjectTransaction,
  found: Pick<
    ProjectRow,
    "id" | "ownerId" | "organizationId" | "organizationRole"
  >,
  userIds: readonly string[],
  accessible?: Map<string, AccessibleProjectPerson>,
): Promise<Record<string, ResolvedMention>> {
  const uniqueIds = [...new Set(userIds)];
  if (!uniqueIds.length) return {};
  const people = accessible ?? (await listProjectAccessiblePeople(tx, found));
  const resolved: Record<string, ResolvedMention> = {};
  const missing: string[] = [];

  for (const id of uniqueIds) {
    const active = people.get(id);
    if (active) {
      resolved[id] = {
        id: active.id,
        name: active.name,
        image: active.image,
        status: "active",
      };
    } else {
      missing.push(id);
    }
  }

  if (missing.length) {
    const existing = await tx
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.id, missing));
    const existingIds = new Set(existing.map((row) => row.id));
    for (const id of missing) {
      resolved[id] = existingIds.has(id)
        ? {
            id,
            name: "Former collaborator",
            image: null,
            status: "former",
          }
        : {
            id,
            name: "Deleted user",
            image: null,
            status: "deleted",
          };
    }
  }

  return resolved;
}
