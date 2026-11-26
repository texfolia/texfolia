export const organizationRoleNames = ["member", "admin", "owner"] as const;
export type OrganizationRole = (typeof organizationRoleNames)[number];

export const organizationRoleLabels: Record<OrganizationRole, string> = {
  member: "Member",
  admin: "Admin",
  owner: "Owner",
};

/**
 * Better Auth stores a member's organization roles as one comma-separated
 * string, such as "owner" or "admin,member".
 */
export function hasOrgRole(role: string, ...roles: string[]) {
  return role.split(",").some((item) => roles.includes(item.trim()));
}

/** Owners and admins manage the organization's projects and billing. */
export function isOrgAdmin(role: string) {
  return hasOrgRole(role, "owner", "admin");
}

/** The role that decides what a member with these stored roles can do. */
export function mainOrgRole(role: string): OrganizationRole {
  if (hasOrgRole(role, "owner")) return "owner";
  return hasOrgRole(role, "admin") ? "admin" : "member";
}
