import {
  member,
  project,
  projectCollaborator,
  projectShareLink,
} from "@texfolia/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  projectLock,
  type ProjectGrant,
  type ProjectTransaction,
} from "#/lib/projects/server";

// Composes project access: `#/lib/projects` checks owners and organization
// members; collaborator invitations and share links are granted here.

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

const shareLinkGrant: ProjectGrant = async ({
  tx,
  projectId,
  userId,
  access,
  content,
}) => {
  const linkId = shareLinkIdOf(userId);
  if (linkId === null) return null;
  if (access === "write") throw new Error("Project not found");
  const [link] = await tx
    .select({ scope: projectShareLink.scope })
    .from(projectShareLink)
    .where(
      and(
        eq(projectShareLink.id, linkId),
        eq(projectShareLink.projectId, projectId),
      ),
    )
    .for("share");
  if (!link || (link.scope === "pdf" && content !== "build"))
    throw new Error("Project not found");
  return { canWrite: false, shareScope: link.scope };
};

// Collaborators apply to personal projects only; organization projects are
// governed by membership.
const collaboratorGrant: ProjectGrant = async ({
  tx,
  projectId,
  userId,
  access,
  project,
}) => {
  if (project.organizationId) return null;
  const [collaborator] = await tx
    .select()
    .from(projectCollaborator)
    .where(
      and(
        eq(projectCollaborator.projectId, projectId),
        eq(projectCollaborator.userId, userId),
      ),
    )
    .for("share");
  if (!collaborator || (access === "write" && collaborator.role !== "editor"))
    throw new Error("Project not found");
  return { canWrite: collaborator.role === "editor", shareScope: null };
};

// Share-link principals never match an owner, member, or collaborator, so the
// link grant runs first and the collaborator grant can deny everyone else.
export const lockProject = projectLock([shareLinkGrant, collaboratorGrant]);

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
      ownerId: project.ownerId,
      organizationId: project.organizationId,
    })
    .from(project)
    .where(and(eq(project.id, projectId), isNull(project.deletedAt)))
    .for("share");
  if (!found) return readers;
  const links = new Map<string, string>();
  const accounts: string[] = [];
  for (const userId of userIds) {
    const linkId = shareLinkIdOf(userId);
    if (linkId === null) accounts.push(userId);
    else links.set(linkId, userId);
  }
  if (accounts.length && found.organizationId) {
    for (const { userId } of await tx
      .select({ userId: member.userId })
      .from(member)
      .where(
        and(
          eq(member.organizationId, found.organizationId),
          inArray(member.userId, accounts),
        ),
      )
      .for("share"))
      readers.set(userId, { canWrite: true });
  } else if (accounts.length) {
    for (const { userId, role } of await tx
      .select({
        userId: projectCollaborator.userId,
        role: projectCollaborator.role,
      })
      .from(projectCollaborator)
      .where(
        and(
          eq(projectCollaborator.projectId, projectId),
          inArray(projectCollaborator.userId, accounts),
        ),
      )
      .for("share"))
      readers.set(userId, { canWrite: role === "editor" });
    if (found.ownerId && accounts.includes(found.ownerId))
      readers.set(found.ownerId, { canWrite: true });
  }
  if (links.size)
    for (const { id, scope } of await tx
      .select({ id: projectShareLink.id, scope: projectShareLink.scope })
      .from(projectShareLink)
      .where(
        and(
          eq(projectShareLink.projectId, projectId),
          inArray(projectShareLink.id, [...links.keys()]),
        ),
      )
      .for("share")) {
      const principal = links.get(id);
      if (principal && scope === "project")
        readers.set(principal, { canWrite: false });
    }
  return readers;
}
