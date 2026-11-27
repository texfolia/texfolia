import type { Db } from "@texfolia/db";
import {
  member,
  project,
  projectCollaborator,
  projectTeam,
  team,
  user,
} from "@texfolia/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import { isOrgAdmin } from "#/lib/auth/roles";
import { projectCollaboratorEmail, type EmailDelivery } from "#/lib/email";
import {
  invalidateProjectAccess,
  isProjectManager,
  requireProjectManager,
  type LiveProjects,
  type ProjectTransaction,
} from "#/lib/projects/server";

import { lockProject } from "./project-access.server";
import type {
  grantProjectAccessSchema,
  grantTeamAccessSchema,
  revokeProjectAccessSchema,
  revokeTeamAccessSchema,
  setOrganizationRoleSchema,
} from "./project-sharing.schema";
import { takeSharingEmail } from "./sharing-limit.server";

type AccessRequest = { db: Db; userId: string; projectId: string };

// Locks the project for writing, and allows only the people who manage it: a
// personal project's owner, or its organization's owners and admins.
async function lockManagedProject(
  tx: ProjectTransaction,
  projectId: string,
  userId: string,
) {
  const found = await lockProject({ tx, projectId, userId });
  await requireProjectManager(tx, found, userId).catch(() => {
    throw new Error("Only people who manage this project can manage access.");
  });
  return found;
}

function requireOrganizationProject(found: { organizationId: string | null }) {
  if (!found.organizationId)
    throw new Error("Only organization projects have teams and members.");
  return found.organizationId;
}

/**
 * Who has access: the owner or the organization's managers, the people and
 * teams granted a role, and for organization projects what every member may
 * do. Only managers see emails and the teams they could add.
 */
export async function getProjectAccess({
  db,
  userId,
  projectId,
}: AccessRequest) {
  return db.transaction(async (tx) => {
    const found = await lockProject({ tx, projectId, userId, access: "read" });
    const canManage = await isProjectManager(tx, found, userId);
    const collaborators = tx
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: projectCollaborator.role,
      })
      .from(projectCollaborator)
      .innerJoin(user, eq(projectCollaborator.userId, user.id));
    const people = await (
      found.organizationId
        ? // Grants count only while the person is a member.
          collaborators.innerJoin(
            member,
            and(
              eq(member.userId, projectCollaborator.userId),
              eq(member.organizationId, found.organizationId),
            ),
          )
        : collaborators
    ).where(eq(projectCollaborator.projectId, projectId));
    const owner = found.ownerId
      ? await tx.query.user.findFirst({
          where: { id: found.ownerId },
          columns: { id: true, name: true, email: true },
        })
      : undefined;
    let organization = null;
    if (found.organizationId) {
      const [teams, members, named] = await Promise.all([
        tx
          .select({ id: team.id, name: team.name, role: projectTeam.role })
          .from(team)
          .leftJoin(
            projectTeam,
            and(
              eq(projectTeam.teamId, team.id),
              eq(projectTeam.projectId, projectId),
            ),
          )
          .where(eq(team.organizationId, found.organizationId))
          .orderBy(asc(team.name)),
        tx
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            role: member.role,
          })
          .from(member)
          .innerJoin(user, eq(member.userId, user.id))
          .where(eq(member.organizationId, found.organizationId)),
        tx.query.organization.findFirst({
          where: { id: found.organizationId },
          columns: { name: true },
        }),
      ]);
      organization = {
        name: named?.name ?? "Organization",
        role: found.organizationRole,
        // Teams without access are listed only for managers to add.
        teams: teams.filter((item) => item.role !== null || canManage),
        // Owners and admins, who can always edit.
        managers: members
          .filter((person) => isOrgAdmin(person.role))
          .map(({ role: _role, ...person }) => person),
        // Everyone a manager could add or transfer the project to.
        members: canManage
          ? members.map(({ role: _role, ...person }) => person)
          : [],
      };
    }
    const hide = <Person extends { email: string }>(
      person: Person,
    ): Omit<Person, "email"> & { email: string | null } => ({
      ...person,
      email: canManage ? person.email : null,
    });
    return {
      canManage,
      organization: organization && {
        ...organization,
        managers: organization.managers.map(hide),
        members: organization.members.map(hide),
      },
      owner: owner ? hide(owner) : null,
      people: people.map(hide).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/**
 * Gives the account with this email a role, if there is one. The result is the
 * same either way, so it doesn't tell whether the email has an account. On an
 * organization project the person must be a member of its organization; share
 * a link with anyone else.
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
  const result = await db.transaction(async (tx) => {
    const found = await lockManagedProject(tx, data.projectId, userId);
    const targetEmail = data.email.trim().toLowerCase();
    const [person] = await tx
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(sql`lower(${user.email}) = ${targetEmail}`)
      .limit(1);
    if (person?.id === userId)
      throw new Error("You already have access to this project.");
    if (found.organizationId) {
      // Organizations already know their members, so this reveals nothing.
      const [membership] = person
        ? await tx
            .select({ userId: member.userId })
            .from(member)
            .where(
              and(
                eq(member.organizationId, found.organizationId),
                eq(member.userId, person.id),
              ),
            )
        : [];
      if (!membership)
        throw new Error(
          "Only members of this organization can be added. Share a link with anyone else.",
        );
    }
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
    if (existing) return { personId: person.id };
    const [inviter] = await tx
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return {
      personId: person.id,
      added: {
        recipientEmail: person.email,
        projectName: found.name,
        inviterName: inviter?.name ?? "Someone",
      },
    };
  });
  if (!result) return;
  await invalidateProjectAccess(live, data.projectId, [result.personId]);
  if (!result.added || !email) return;
  const { added } = result;
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
    await lockManagedProject(tx, data.projectId, userId);
    await tx
      .delete(projectCollaborator)
      .where(
        and(
          eq(projectCollaborator.projectId, data.projectId),
          eq(projectCollaborator.userId, data.userId),
        ),
      );
  });
  await invalidateProjectAccess(live, data.projectId, [data.userId]);
}

export async function setOrganizationRole({
  db,
  userId,
  data,
  live,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof setOrganizationRoleSchema>;
  live?: LiveProjects;
}) {
  await db.transaction(async (tx) => {
    const found = await lockManagedProject(tx, data.projectId, userId);
    requireOrganizationProject(found);
    await tx
      .update(project)
      .set({ organizationRole: data.role })
      .where(eq(project.id, data.projectId));
  });
  // Every member may have gained or lost access.
  await invalidateProjectAccess(live, data.projectId);
}

export async function grantTeamAccess({
  db,
  userId,
  data,
  live,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof grantTeamAccessSchema>;
  live?: LiveProjects;
}) {
  await db.transaction(async (tx) => {
    const found = await lockManagedProject(tx, data.projectId, userId);
    const organizationId = requireOrganizationProject(found);
    const [granted] = await tx
      .select({ id: team.id })
      .from(team)
      .where(
        and(eq(team.id, data.teamId), eq(team.organizationId, organizationId)),
      )
      .for("share");
    if (!granted) throw new Error("Team not found");
    await tx
      .insert(projectTeam)
      .values({
        projectId: data.projectId,
        teamId: data.teamId,
        role: data.role,
      })
      .onConflictDoUpdate({
        target: [projectTeam.projectId, projectTeam.teamId],
        set: { role: data.role },
      });
  });
  await invalidateProjectAccess(live, data.projectId);
}

export async function revokeTeamAccess({
  db,
  userId,
  data,
  live,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof revokeTeamAccessSchema>;
  live?: LiveProjects;
}) {
  await db.transaction(async (tx) => {
    await lockManagedProject(tx, data.projectId, userId);
    await tx
      .delete(projectTeam)
      .where(
        and(
          eq(projectTeam.projectId, data.projectId),
          eq(projectTeam.teamId, data.teamId),
        ),
      );
  });
  await invalidateProjectAccess(live, data.projectId);
}
