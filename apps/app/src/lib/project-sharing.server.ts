import type { Db } from "@texfolia/db";
import { member, projectCollaborator, user } from "@texfolia/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import {
  invalidateCollaborationAccess,
  type CollaborationAccess,
} from "#/features/collaboration/server";

import { lockProject } from "./project-access.server";
import type {
  grantProjectAccessSchema,
  revokeProjectAccessSchema,
} from "./project-sharing.schema";

type AccessRequest = { db: Db; userId: string; projectId: string };

export async function getProjectAccess({
  db,
  userId,
  projectId,
}: AccessRequest) {
  return db.transaction(async (tx) => {
    const found = await lockProject({ tx, projectId, userId, access: "read" });
    const people = found.organizationId
      ? await tx
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            role: member.role,
          })
          .from(member)
          .innerJoin(user, eq(member.userId, user.id))
          .where(eq(member.organizationId, found.organizationId))
      : await tx
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            role: projectCollaborator.role,
          })
          .from(projectCollaborator)
          .innerJoin(user, eq(projectCollaborator.userId, user.id))
          .where(eq(projectCollaborator.projectId, projectId));
    const owner = found.ownerId
      ? await tx.query.user.findFirst({
          where: { id: found.ownerId },
          columns: { id: true, name: true, email: true },
        })
      : undefined;
    return {
      canManage: found.ownerId === userId,
      organization: !!found.organizationId,
      people: [...(owner ? [{ ...owner, role: "owner" }] : []), ...people].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
    };
  });
}

export async function grantProjectAccess({
  db,
  userId,
  data,
  collaboration,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof grantProjectAccessSchema>;
  collaboration?: CollaborationAccess;
}) {
  await db.transaction(async (tx) => {
    const found = await lockProject({ tx, projectId: data.projectId, userId });
    if (found.ownerId !== userId)
      throw new Error("Only the project owner can manage access.");
    const [person] = await tx
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${data.email}`)
      .limit(1);
    if (!person)
      throw new Error(
        "No Texfolia account has that email. Ask them to sign in first, then try again.",
      );
    if (person.id === userId) throw new Error("You already own this project.");
    await tx
      .insert(projectCollaborator)
      .values({ projectId: data.projectId, userId: person.id, role: data.role })
      .onConflictDoUpdate({
        target: [projectCollaborator.projectId, projectCollaborator.userId],
        set: { role: data.role, updatedAt: new Date() },
      });
    // Invalidate before commit so open sockets re-verify behind this lock.
    await invalidateCollaborationAccess(collaboration, data.projectId, [
      person.id,
    ]);
  });
}

export async function revokeProjectAccess({
  db,
  userId,
  data,
  collaboration,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof revokeProjectAccessSchema>;
  collaboration?: CollaborationAccess;
}) {
  await db.transaction(async (tx) => {
    const found = await lockProject({ tx, projectId: data.projectId, userId });
    if (found.ownerId !== userId)
      throw new Error("Only the project owner can manage access.");
    await tx
      .delete(projectCollaborator)
      .where(
        and(
          eq(projectCollaborator.projectId, data.projectId),
          eq(projectCollaborator.userId, data.userId),
        ),
      );
    // Invalidate before commit so open sockets re-verify behind this lock.
    await invalidateCollaborationAccess(collaboration, data.projectId, [
      data.userId,
    ]);
  });
}
