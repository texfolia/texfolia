// Project permissions, Google Docs style. Client-safe: the workspace and the
// sharing dialogs use the same names and labels as the access checks.

/** From least to most access. */
export const projectRoles = ["viewer", "commenter", "editor"] as const;
export type ProjectRole = (typeof projectRoles)[number];

export const projectRoleLabels: Record<ProjectRole, string> = {
  viewer: "Can view",
  commenter: "Can comment",
  editor: "Can edit",
};

/**
 * What a request needs. Reading covers sources, the PDF, and existing
 * comments; commenting adds, replies to, and resolves comments; writing edits
 * sources and runs compiles and Git.
 */
export type ProjectAccessLevel = "read" | "comment" | "write";

const levelRoles: Record<ProjectAccessLevel, ProjectRole> = {
  read: "viewer",
  comment: "commenter",
  write: "editor",
};

function rank(role: ProjectRole) {
  return projectRoles.indexOf(role);
}

export function roleAllows(role: ProjectRole, level: ProjectAccessLevel) {
  return rank(role) >= rank(levelRoles[level]);
}

/** The role with more access; grants from different sources add up. */
export function strongerRole<Role extends ProjectRole | null | undefined>(
  a: Role,
  b: Role,
) {
  if (!a) return b;
  if (!b) return a;
  return rank(a) >= rank(b) ? a : b;
}

export type ProjectPermissions = {
  role: ProjectRole;
  canWrite: boolean;
  canComment: boolean;
  // An anonymous share-link guest: no account, so no comments, scratchpad, or
  // assistant, and never more than view access.
  guest: boolean;
};

export function projectPermissions(
  role: ProjectRole,
  guest = false,
): ProjectPermissions {
  return {
    role,
    canWrite: roleAllows(role, "write"),
    canComment: !guest && roleAllows(role, "comment"),
    guest,
  };
}
