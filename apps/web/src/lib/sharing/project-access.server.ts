import {
  member,
  project,
  projectCollaborator,
  projectShareGrant,
  projectShareLink,
  projectTeam,
  teamMember,
} from "@texfolia/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { isOrgAdmin } from "#/lib/auth/roles";
import {
  projectLock,
  strongerRole,
  type ProjectGrant,
  type ProjectRole,
  type ProjectRow,
  type ProjectTransaction,
} from "#/lib/projects/server";

// Composes project access: `#/lib/projects` checks owners and organization
// members; people, teams, and share links are granted here.

// Anonymous share-link viewers act as this principal wherever a user ID is
// checked. Account IDs never contain a colon, so the prefix cannot collide.
const sharePrefix = "share:";

export function sharePrincipal(linkId: string) {
  return `${sharePrefix}${linkId}`;
}

export function shareLinkIdOf(principal: string) {
  return principal.startsWith(sharePrefix)
    ? principal.slice(sharePrefix.length)
    : null;
}

type Granted = Map<string, { role: ProjectRole; guest: boolean }>;

function grant(
  granted: Granted,
  userId: string,
  role: ProjectRole,
  guest = false,
) {
  const current = granted.get(userId);
  if (!current || strongerRole(current.role, role) !== current.role)
    granted.set(userId, { role, guest });
}

// Roles from collaborators, teams, and share links for these principals; owner
// and organization roles are not included. Rows are locked for sharing, so the
// check waits behind a revocation in progress. On organization projects,
// collaborators and teams count only for current members, while share links
// count for anyone.
async function sharedRoles(
  tx: ProjectTransaction,
  found: Pick<ProjectRow, "id" | "organizationId">,
  userIds: readonly string[],
) {
  const granted: Granted = new Map();
  const links = new Map<string, string>();
  const accounts: string[] = [];
  for (const userId of userIds) {
    const linkId = shareLinkIdOf(userId);
    if (linkId === null) accounts.push(userId);
    else links.set(linkId, userId);
  }
  if (accounts.length) {
    const collaborators = tx
      .select({
        userId: projectCollaborator.userId,
        role: projectCollaborator.role,
      })
      .from(projectCollaborator);
    for (const { userId, role } of await (
      found.organizationId
        ? collaborators.innerJoin(
            member,
            and(
              eq(member.userId, projectCollaborator.userId),
              eq(member.organizationId, found.organizationId),
            ),
          )
        : collaborators
    )
      .where(
        and(
          eq(projectCollaborator.projectId, found.id),
          inArray(projectCollaborator.userId, accounts),
        ),
      )
      .for("share", { of: projectCollaborator }))
      grant(granted, userId, role);
    if (found.organizationId)
      for (const { userId, role } of await tx
        .select({ userId: teamMember.userId, role: projectTeam.role })
        .from(projectTeam)
        .innerJoin(teamMember, eq(teamMember.teamId, projectTeam.teamId))
        .innerJoin(
          member,
          and(
            eq(member.userId, teamMember.userId),
            eq(member.organizationId, found.organizationId),
          ),
        )
        .where(
          and(
            eq(projectTeam.projectId, found.id),
            inArray(teamMember.userId, accounts),
          ),
        )
        .for("share", { of: [projectTeam, teamMember] }))
        grant(granted, userId, role);
    for (const { userId, role } of await tx
      .select({ userId: projectShareGrant.userId, role: projectShareLink.role })
      .from(projectShareGrant)
      .innerJoin(
        projectShareLink,
        eq(projectShareLink.id, projectShareGrant.linkId),
      )
      .where(
        and(
          eq(projectShareGrant.projectId, found.id),
          eq(projectShareLink.projectId, found.id),
          inArray(projectShareGrant.userId, accounts),
        ),
      )
      .for("share", { of: projectShareLink }))
      grant(granted, userId, role);
  }
  // Anonymous guests can only view, and only through view links.
  if (links.size)
    for (const { id } of await tx
      .select({ id: projectShareLink.id })
      .from(projectShareLink)
      .where(
        and(
          eq(projectShareLink.projectId, found.id),
          eq(projectShareLink.role, "viewer"),
          inArray(projectShareLink.id, [...links.keys()]),
        ),
      )
      .for("share")) {
      const principal = links.get(id);
      if (principal) grant(granted, principal, "viewer", true);
    }
  return granted;
}

const sharingGrant: ProjectGrant = async ({ tx, userId, project }) =>
  (await sharedRoles(tx, project, [userId])).get(userId) ?? null;

export const lockProject = projectLock([sharingGrant]);

// Which of these principals may read a project's sources, and whether they may
// edit them: `lockProject` for many people in one round of queries. Locks like it,
// so it waits behind a revocation in progress.
export async function lockProjectReaders({
  tx,
  projectId,
  userIds,
}: {
  tx: ProjectTransaction;
  projectId: string;
  userIds: readonly string[];
}) {
  const readers = new Map<string, { canWrite: boolean }>();
  const [found] = await tx
    .select({
      id: project.id,
      ownerId: project.ownerId,
      organizationId: project.organizationId,
      organizationRole: project.organizationRole,
    })
    .from(project)
    .where(and(eq(project.id, projectId), isNull(project.deletedAt)))
    .for("share");
  if (!found) return readers;
  const granted = await sharedRoles(tx, found, userIds);
  const accounts = userIds.filter((userId) => shareLinkIdOf(userId) === null);
  if (accounts.length && found.organizationId) {
    for (const { userId, role } of await tx
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .where(
        and(
          eq(member.organizationId, found.organizationId),
          inArray(member.userId, accounts),
        ),
      )
      .for("share")) {
      const organizationRole = isOrgAdmin(role)
        ? "editor"
        : found.organizationRole;
      if (organizationRole) grant(granted, userId, organizationRole);
    }
  } else if (found.ownerId && accounts.includes(found.ownerId))
    grant(granted, found.ownerId, "editor");
  for (const [userId, { role }] of granted)
    readers.set(userId, { canWrite: role === "editor" });
  return readers;
}
