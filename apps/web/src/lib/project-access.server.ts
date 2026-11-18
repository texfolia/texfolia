import type { Db } from "@texfolia/db";
import {
  member,
  project,
  projectCollaborator,
  projectShareLink,
} from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";

export type ProjectTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

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

export async function lockProject({
  tx,
  projectId,
  userId,
  access = "write",
  content = "sources",
}: {
  tx: ProjectTransaction;
  projectId: string;
  userId: string;
  access?: "read" | "write";
  // "build" covers build files, the PDF, and the live build stream. PDF-only
  // share links can read only these.
  content?: "sources" | "build";
}) {
  const [found] = await tx
    .select()
    .from(project)
    .where(and(eq(project.id, projectId), isNull(project.deletedAt)))
    .for(access === "write" ? "update" : "share");
  if (!found) throw new Error("Project not found");
  const linkId = shareLinkIdOf(userId);
  if (linkId !== null) {
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
    return { ...found, canWrite: false, shareScope: link.scope };
  }
  if (found.organizationId) {
    const [membership] = await tx
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, found.organizationId),
          eq(member.userId, userId),
        ),
      )
      .for("share");
    if (!membership) throw new Error("Project not found");
    // Every org role can edit org projects; see docs/project-controls.md.
    return { ...found, canWrite: true, shareScope: null };
  }
  if (found.ownerId === userId)
    return { ...found, canWrite: true, shareScope: null };
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
  return {
    ...found,
    canWrite: collaborator.role === "editor",
    shareScope: null,
  };
}
