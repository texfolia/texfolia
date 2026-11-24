import type { Db } from "@texfolia/db";
import { member, projectCollaborator, user } from "@texfolia/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import {
  invalidateCollaborationAccess,
  type CollaborationAccess,
} from "#/features/collaboration/server";
import {
  projectCollaboratorEmail,
  type EmailDelivery,
  type EmailNotificationStatus,
} from "#/features/email";

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
  email,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof grantProjectAccessSchema>;
  collaboration?: CollaborationAccess;
  email?: EmailDelivery;
}): Promise<{ added: boolean; notification: EmailNotificationStatus }> {
  const outcome = await db.transaction(async (tx) => {
    const found = await lockProject({ tx, projectId: data.projectId, userId });
    if (found.ownerId !== userId)
      throw new Error("Only the project owner can manage access.");
    const targetEmail = data.email.trim().toLowerCase();
    const [person] = await tx
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(sql`lower(${user.email}) = ${targetEmail}`)
      .limit(1);
    if (!person)
      throw new Error(
        "No Texfolia account has that email. Ask them to sign in first, then try again.",
      );
    if (person.id === userId) throw new Error("You already own this project.");
    const [existing] = await tx
      .select({ role: projectCollaborator.role })
      .from(projectCollaborator)
      .where(
        and(
          eq(projectCollaborator.projectId, data.projectId),
          eq(projectCollaborator.userId, person.id),
        ),
      )
      .limit(1);
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
    if (existing) return { added: false as const };
    const [inviter] = await tx
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return {
      added: true as const,
      recipientEmail: person.email,
      projectName: found.name,
      inviterName: inviter?.name ?? "Someone",
    };
  });
  if (!outcome.added || !email) {
    return { added: outcome.added, notification: "none" };
  }
  const url = new URL(
    `/project/${encodeURIComponent(data.projectId)}`,
    email.baseURL,
  );
  try {
    await email.send(
      projectCollaboratorEmail({
        to: outcome.recipientEmail,
        projectName: outcome.projectName,
        inviterName: outcome.inviterName,
        role: data.role,
        url,
      }),
    );
    return { added: true, notification: "sent" };
  } catch (error) {
    console.error("Failed to send project collaborator email", error);
    return { added: true, notification: "failed" };
  }
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
