import { z } from "zod";

import { shareTokenPattern } from "./share-token";

export const shareTokenSchema = z.string().regex(shareTokenPattern);
export const shareLinkScopeSchema = z.enum(["project", "pdf"]);
export type ShareLinkScope = z.infer<typeof shareLinkScopeSchema>;

export const shareLinksSchema = z.object({ projectId: z.uuid() });
export const createShareLinkSchema = shareLinksSchema.extend({
  scope: shareLinkScopeSchema,
  recipientEmail: z.string().trim().toLowerCase().pipe(z.email()).optional(),
});
export const revokeShareLinkSchema = shareLinksSchema.extend({
  linkId: z.uuid(),
});
export const sharedProjectSchema = z.object({ token: shareTokenSchema });

export const shareLinkLimit = 10;
