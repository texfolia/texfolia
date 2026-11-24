import type { Db } from "@texfolia/db";
import { member, projectCollaborator, user } from "@texfolia/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import { isOrgAdmin } from "#/lib/auth/roles";
import { projectCollaboratorEmail, type EmailDelivery } from "#/lib/email";
import {
  invalidateProjectAccess,
  type LiveProjects,
} from "#/lib/projects/server";

import { lockProject } from "./project-access.server";
import type {
  grantProjectAccessSchema,
  revokeProjectAccessSchema,
} from "./project-sharing.schema";
import { takeSharingEmail } from "./sharing-limit.server";

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
    const canManage = found.ownerId === userId;
    // Only people who manage access see emails: a personal project's owner, or
    // an organization's owners and admins, who can transfer its projects.
    const showEmails =
      canManage ||
      (!!found.organizationId &&
        people.some(
          (person) => person.id === userId && isOrgAdmin(person.role),
        ));
    return {
      canManage,
      organization: !!found.organizationId,
      people: [...(owner ? [{ ...owner, role: "owner" }] : []), ...people]
        .map((person) => ({
          ...person,
          email: showEmails ? person.email : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/**
 * Gives the account with this email access, if there is one. The result is the
 * same either way, so it doesn't tell whether the email has an account.
 */
export async function grantProjectAccess({
  db,
  userId,
  data,
  live,
  email,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof grantProjectAccessSchema>;
  live?: LiveProjects;
  email?: EmailDelivery;
}) {
  const added = await db.transaction(async (tx) => {
    const found = await lockProject({ tx, projectId: data.projectId, userId });
    if (found.ownerId !== userId)
      throw new Error("Only the project owner can manage access.");
    const targetEmail = data.email.trim().toLowerCase();
    const [person] = await tx
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(sql`lower(${user.email}) = ${targetEmail}`)
      .limit(1);
    if (person?.id === userId) throw new Error("You already own this project.");
    const [existing] = person
      ? await tx
          .select({ role: projectCollaborator.role })
          .from(projectCollaborator)
          .where(
            and(
              eq(projectCollaborator.projectId, data.projectId),
              eq(projectCollaborator.userId, person.id),
            ),
          )
          .limit(1)
      : [];
    // Changing a collaborator's role sends no email, so it isn't limited.
    if (!existing) await takeSharingEmail(tx, userId);
    if (!person) return;
    await tx
      .insert(projectCollaborator)
      .values({ projectId: data.projectId, userId: person.id, role: data.role })
      .onConflictDoUpdate({
        target: [projectCollaborator.projectId, projectCollaborator.userId],
        set: { role: data.role, updatedAt: new Date() },
      });
    // Invalidate before commit so open sockets re-verify behind this lock.
    await invalidateProjectAccess(live, data.projectId, [person.id]);
    if (existing) return;
    const [inviter] = await tx
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return {
      recipientEmail: person.email,
      projectName: found.name,
      inviterName: inviter?.name ?? "Someone",
    };
  });
  if (!added || !email) return;
  const url = new URL(
    `/project/${encodeURIComponent(data.projectId)}`,
    email.baseURL,
  );
  try {
    await email.send(
      projectCollaboratorEmail({
        to: added.recipientEmail,
        projectName: added.projectName,
        inviterName: added.inviterName,
        role: data.role,
        url,
      }),
    );
  } catch (error) {
    console.error("Failed to queue project collaborator email", error);
  }
}

export async function revokeProjectAccess({
  db,
  userId,
  data,
  live,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof revokeProjectAccessSchema>;
  live?: LiveProjects;
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
    await invalidateProjectAccess(live, data.projectId, [data.userId]);
  });
}
