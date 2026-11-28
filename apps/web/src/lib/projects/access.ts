import type { Db } from "@texfolia/db";
import { member, project } from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import { isOrgAdmin } from "#/lib/auth/roles";

import {
  projectPermissions,
  roleAllows,
  strongerRole,
  type ProjectAccessLevel,
  type ProjectPermissions,
  type ProjectRole,
} from "./roles";

export type ProjectTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

export type ProjectRow = typeof project.$inferSelect;

export type ProjectAccessRequest = {
  tx: ProjectTransaction;
  projectId: string;
  userId: string;
  access?: ProjectAccessLevel;
};

export type ProjectAccess = ProjectPermissions;

export type ProjectGrantResult = { role: ProjectRole; guest?: boolean } | null;

// Access this feature does not own, such as collaborators, teams, or share
// links. A grant sees the locked project row and returns the role it gives,
// or `null`. Roles from every source add up; see `strongerRole`.
export type ProjectGrant = (request: {
  tx: ProjectTransaction;
  projectId: string;
  userId: string;
  project: ProjectRow;
}) => Promise<ProjectGrantResult>;

// Owner and organization access. A personal project's owner, and an
// organization's owners and admins, can edit. Other members get the project's
// organization-wide role, if it has one; see docs/project-controls.md.
async function ownerAccess(
  tx: ProjectTransaction,
  found: ProjectRow,
  userId: string,
): Promise<ProjectGrantResult> {
  if (found.organizationId) {
    const [membership] = await tx
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.organizationId, found.organizationId),
          eq(member.userId, userId),
        ),
      )
      .for("share");
    if (!membership) return null;
    if (isOrgAdmin(membership.role)) return { role: "editor" };
    return found.organizationRole ? { role: found.organizationRole } : null;
  }
  return found.ownerId === userId ? { role: "editor" } : null;
}

// Locks a live project row (exclusively for writes, shared otherwise) and
// checks access: the strongest role from owner and organization access and
// every grant. Throws "Project not found" when none allows `access`, so people
// without access cannot tell the project exists.
export async function lockProject({
  tx,
  projectId,
  userId,
  access = "write",
  grants = [],
}: ProjectAccessRequest & { grants?: readonly ProjectGrant[] }) {
  const [found] = await tx
    .select()
    .from(project)
    .where(and(eq(project.id, projectId), isNull(project.deletedAt)))
    .for(access === "write" ? "update" : "share");
  if (!found) throw new Error("Project not found");
  let granted = await ownerAccess(tx, found, userId);
  for (const grant of grants) {
    if (granted?.role === "editor") break;
    const next = await grant({ tx, projectId, userId, project: found });
    if (next && strongerRole(granted?.role, next.role) === next.role)
      granted = next;
  }
  if (!granted || !roleAllows(granted.role, access))
    throw new Error("Project not found");
  return {
    ...found,
    ...projectPermissions(granted.role, granted.guest ?? false),
  };
}

// Whether this person manages the project: the owner of a personal project, or
// an owner or admin of its organization. Managers share, trash, restore,
// permanently delete, and transfer it. Collaborators, teams, and share links
// never manage. Callers hold the project row's lock.
export async function isProjectManager(
  tx: ProjectTransaction,
  found: Pick<ProjectRow, "ownerId" | "organizationId">,
  userId: string,
) {
  if (!found.organizationId) return found.ownerId === userId;
  const [membership] = await tx
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, found.organizationId),
        eq(member.userId, userId),
      ),
    )
    .for("share");
  return !!membership && isOrgAdmin(membership.role);
}

// Throws unless `isProjectManager`.
export async function requireProjectManager(
  tx: ProjectTransaction,
  found: Pick<ProjectRow, "ownerId" | "organizationId">,
  userId: string,
) {
  if (!found.organizationId) {
    if (found.ownerId !== userId) throw new Error("Project not found");
    return;
  }
  const [membership] = await tx
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, found.organizationId),
        eq(member.userId, userId),
      ),
    )
    .for("share");
  if (!membership) throw new Error("Project not found");
  if (!isOrgAdmin(membership.role))
    throw new Error("Only organization owners and admins can manage projects");
}

// Personal project names are unique per owner, so a project that joins an
// owner's list takes the first free name. Callers hold the owner's row lock to
// keep concurrent allocations apart.
export async function availableProjectName(
  tx: ProjectTransaction,
  owner: { ownerId: string } | { organizationId: string },
  requested: string,
) {
  const rows = await tx
    .select({ name: project.name })
    .from(project)
    .where(
      and(
        "ownerId" in owner
          ? eq(project.ownerId, owner.ownerId)
          : eq(project.organizationId, owner.organizationId),
        isNull(project.deletedAt),
      ),
    );
  const names = new Set(rows.map((row) => row.name));
  let name = requested;
  for (let suffix = 2; names.has(name); suffix++)
    name = `${requested} (${suffix})`;
  return name;
}

export type LockProject = (
  request: ProjectAccessRequest,
) => ReturnType<typeof lockProject>;

export function projectLock(grants: readonly ProjectGrant[]): LockProject {
  return (request) => lockProject({ ...request, grants });
}
