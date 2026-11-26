import type { Db } from "@texfolia/db";
import { project, template } from "@texfolia/db/schema";
import { count, eq } from "drizzle-orm";

import { isOrgAdmin } from "./roles";

/**
 * The organization settings page: the user's organizations, and the selected
 * one's members and teams. Invitations are for the people who manage them.
 */
export async function organizationOverview(
  db: Db,
  { userId, organizationId }: { userId: string; organizationId?: string },
) {
  const memberships = await db.query.member.findMany({
    where: { userId },
    with: { organization: { columns: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const organizations = memberships.flatMap(({ organization, role }) =>
    organization ? [{ ...organization, role }] : [],
  );
  const current = organizationId
    ? organizations.find(({ id }) => id === organizationId)
    : organizations[0];
  if (organizationId && !current) throw new Error("Organization not found");
  if (!current) return { userId, organizations, selected: null };
  const canManage = isOrgAdmin(current.role);
  const [members, invitations, projects, templates, teams] = await Promise.all([
    db.query.member.findMany({
      where: { organizationId: current.id },
      columns: { id: true, userId: true, role: true },
      with: { user: { columns: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    canManage
      ? db.query.invitation.findMany({
          where: {
            organizationId: current.id,
            status: "pending",
            expiresAt: { gt: new Date() },
          },
          columns: { id: true, email: true, role: true, expiresAt: true },
          orderBy: { createdAt: "asc" },
        })
      : [],
    db
      .select({ count: count() })
      .from(project)
      .where(eq(project.organizationId, current.id)),
    db
      .select({ count: count() })
      .from(template)
      .where(eq(template.organizationId, current.id)),
    db.query.team.findMany({
      where: { organizationId: current.id },
      columns: { id: true, name: true },
      with: { teamMembers: { columns: { userId: true } } },
      orderBy: { name: "asc" },
    }),
  ]);
  return {
    userId,
    organizations,
    selected: {
      ...current,
      members: members.flatMap(({ user, ...member }) =>
        user ? [{ ...member, ...user }] : [],
      ),
      invitations,
      // Teams group members for sharing projects; see `projectTeam`.
      teams: teams.map(({ teamMembers, ...item }) => ({
        ...item,
        userIds: teamMembers.map((teamMember) => teamMember.userId),
      })),
      // Including those in the trash, which deleting the organization deletes.
      projectCount: projects[0]?.count ?? 0,
      templateCount: templates[0]?.count ?? 0,
    },
  };
}
