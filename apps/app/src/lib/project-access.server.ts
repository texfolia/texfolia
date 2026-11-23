import { projectCollaborator, projectShareLink } from "@texfolia/db/schema";
import { and, eq } from "drizzle-orm";

import { projectLock, type ProjectGrant } from "#/features/projects/server";

// Composes project access: `#/features/projects` checks owners and organization
// members; collaborator invitations and share links are granted here until
// sharing has its own package (NAT-434).

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
