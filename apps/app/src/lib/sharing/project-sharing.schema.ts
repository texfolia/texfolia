import { z } from "zod";

import { projectRoles } from "#/lib/projects/roles";

const roleSchema = z.enum(projectRoles);

export const projectAccessSchema = z.object({ projectId: z.uuid() });
export const grantProjectAccessSchema = projectAccessSchema.extend({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: roleSchema,
});
export const revokeProjectAccessSchema = projectAccessSchema.extend({
  userId: z.string().min(1),
});
export const transferProjectSchema = projectAccessSchema.extend({
  userId: z.string().min(1),
});
// What every member of an organization project's organization may do; null
// leaves it to the people and teams granted access.
export const setOrganizationRoleSchema = projectAccessSchema.extend({
  role: roleSchema.nullable(),
});
export const grantTeamAccessSchema = projectAccessSchema.extend({
  teamId: z.string().min(1),
  role: roleSchema,
});
export const revokeTeamAccessSchema = projectAccessSchema.extend({
  teamId: z.string().min(1),
});
