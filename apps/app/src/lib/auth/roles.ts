/**
 * Better Auth stores a member's organization roles as one comma-separated
 * string, such as "owner" or "admin,member".
 */
export function hasOrgRole(role: string, ...roles: string[]) {
  return role.split(",").some((item) => roles.includes(item.trim()));
}

/** Owners and admins manage the organization's projects, templates, and billing. */
export function isOrgAdmin(role: string) {
  return hasOrgRole(role, "owner", "admin");
}
