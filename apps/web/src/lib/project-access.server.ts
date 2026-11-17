import type { Db } from "@texfolia/db";
import { member, project, projectCollaborator } from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";

export type ProjectTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

export async function lockProject({
  tx,
  projectId,
  userId,
  access = "write",
}: {
  tx: ProjectTransaction;
  projectId: string;
  userId: string;
  access?: "read" | "write";
}) {
  const [found] = await tx
    .select()
    .from(project)
    .where(and(eq(project.id, projectId), isNull(project.deletedAt)))
    .for(access === "write" ? "update" : "share");
  if (!found) throw new Error("Project not found");
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
    return { ...found, canWrite: true };
  }
  if (found.ownerId === userId) return { ...found, canWrite: true };
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
  return { ...found, canWrite: collaborator.role === "editor" };
}
