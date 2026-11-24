import type { Db } from "@texfolia/db";
import { member, project, projectShareLink } from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import { isOrgAdmin } from "#/lib/auth/roles";

export type ProjectTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

export type ProjectRow = typeof project.$inferSelect;

export type ProjectAccessRequest = {
  tx: ProjectTransaction;
  projectId: string;
  userId: string;
  access?: "read" | "write";
  // "build" covers build files, the PDF, and the live build stream. PDF-only
  // share links can read only these.
  content?: "sources" | "build";
};

export type ProjectAccess = {
  canWrite: boolean;
  // Set only by link-based grants; owner and organization access is `null`.
  shareScope: (typeof projectShareLink.$inferSelect)["scope"] | null;
};

// Access this feature does not own, such as collaborators or share links.
// A grant runs only when owner and organization checks do not apply, sees the
// locked project row, and returns `null` when it does not apply either. It
// throws to deny.
export type ProjectGrant = (
  request: Required<Omit<ProjectAccessRequest, "tx">> & {
    tx: ProjectTransaction;
    project: ProjectRow;
  },
) => Promise<ProjectAccess | null>;

// Owner and organization access. Every organization role can edit
// organization projects; see docs/project-controls.md.
async function ownerAccess(
  tx: ProjectTransaction,
  found: ProjectRow,
  userId: string,
): Promise<ProjectAccess | null> {
  if (found.organizationId) {
    const [membership] = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(
        and(
          eq(member.organizationId, found.organizationId),
          eq(member.userId, userId),
        ),
      )
      .for("share");
    return membership ? { canWrite: true, shareScope: null } : null;
  }
  return found.ownerId === userId ? { canWrite: true, shareScope: null } : null;
}

// Locks a live project row (exclusively for writes, shared for reads) and
// checks access: owner or organization member first, then each grant in
// order. Throws "Project not found" when nothing grants access.
export async function lockProject({
  tx,
  projectId,
  userId,
  access = "write",
  content = "sources",
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
    if (granted) break;
    granted = await grant({
      tx,
      projectId,
      userId,
      access,
      content,
      project: found,
    });
  }
  if (!granted) throw new Error("Project not found");
  return { ...found, ...granted };
}

// Only the owner of a personal project, or an owner or admin of the project's
// organization, may trash, restore, permanently delete, or transfer it. Callers
// hold the project row's lock. Collaborators and share links never pass.
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
