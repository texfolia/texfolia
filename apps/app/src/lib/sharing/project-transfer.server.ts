import type { Db } from "@texfolia/db";
import {
  member,
  project,
  projectCollaborator,
  projectShareLink,
  projectTeam,
  user,
} from "@texfolia/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import {
  availableProjectName,
  invalidateProjectAccess,
  requireProjectManager,
  type LiveProjects,
} from "#/lib/projects/server";

import { lockProject } from "./project-access.server";
import type { transferProjectSchema } from "./project-sharing.schema";

// Makes another person the owner of a personal project, or makes a member the
// personal owner of their organization's project. The new owner must already
// have access, so nobody receives a project they were never part of. The person
// who transfers it stays on as an editor. Share links are revoked: their tokens
// are known only to the previous owner.
export async function transferProject({
  db,
  userId,
  data,
  live,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof transferProjectSchema>;
  live?: LiveProjects;
}) {
  return db.transaction(async (tx) => {
    // Lock users before the project, in a fixed order, as name allocation and
    // tag changes do.
    await tx
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.id, [userId, data.userId]))
      .orderBy(asc(user.id))
      .for("update");
    const found = await lockProject({ tx, projectId: data.projectId, userId });
    await requireProjectManager(tx, found, userId);
    if (data.userId === userId)
      throw new Error("Choose someone else to transfer the project to.");
    const [recipient] = found.organizationId
      ? await tx
          .select({ userId: member.userId })
          .from(member)
          .where(
            and(
              eq(member.organizationId, found.organizationId),
              eq(member.userId, data.userId),
            ),
          )
          .for("share")
      : await tx
          .select({ userId: projectCollaborator.userId })
          .from(projectCollaborator)
          .where(
            and(
              eq(projectCollaborator.projectId, data.projectId),
              eq(projectCollaborator.userId, data.userId),
            ),
          )
          .for("update");
    if (!recipient)
      throw new Error(
        found.organizationId
          ? "Only organization members can receive this project."
          : "Share the project with this person before transferring it.",
      );
    // An organization project's people and teams are its members; none keep
    // access when the project leaves it.
    await tx
      .delete(projectCollaborator)
      .where(
        and(
          eq(projectCollaborator.projectId, data.projectId),
          found.organizationId
            ? undefined
            : inArray(projectCollaborator.userId, [userId, data.userId]),
        ),
      );
    await tx
      .delete(projectShareLink)
      .where(eq(projectShareLink.projectId, data.projectId));
    await tx
      .delete(projectTeam)
      .where(eq(projectTeam.projectId, data.projectId));
    await tx.insert(projectCollaborator).values({
      projectId: data.projectId,
      userId,
      role: "editor",
    });
    const name = await availableProjectName(
      tx,
      { ownerId: data.userId },
      found.name,
    );
    await tx
      .update(project)
      .set({
        ownerId: data.userId,
        organizationId: null,
        name,
      })
      .where(eq(project.id, data.projectId));
    // Invalidate before commit so open sockets re-verify behind this lock.
    await invalidateProjectAccess(live, data.projectId);
    return { name };
  });
}
