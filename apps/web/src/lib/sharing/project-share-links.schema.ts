import { z } from "zod";

import { projectRoles } from "#/lib/projects/roles";

import { shareTokenPattern } from "./share-token";

export const shareTokenSchema = z.string().regex(shareTokenPattern);
export const projectRoleSchema = z.enum(projectRoles);

export const shareLinksSchema = z.object({ projectId: z.uuid() });
export const createShareLinkSchema = shareLinksSchema.extend({
  role: projectRoleSchema,
  recipientEmail: z.string().trim().toLowerCase().pipe(z.email()).optional(),
});
export const revokeShareLinkSchema = shareLinksSchema.extend({
  linkId: z.uuid(),
});

export const shareLinkLimit = 10;
