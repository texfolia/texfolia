import { z } from "zod";

// 32 random bytes, base64url without padding.
export const shareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const shareLinkScopeSchema = z.enum(["project", "pdf"]);
export type ShareLinkScope = z.infer<typeof shareLinkScopeSchema>;

export const shareLinksSchema = z.object({ projectId: z.uuid() });
export const createShareLinkSchema = shareLinksSchema.extend({
  scope: shareLinkScopeSchema,
});
export const revokeShareLinkSchema = shareLinksSchema.extend({
  linkId: z.uuid(),
});
export const sharedProjectSchema = z.object({ token: shareTokenSchema });

export const shareLinkLimit = 10;
export const shareSearchParam = "share";

export function sharePath(token: string) {
  return `/share/${token}`;
}

// Appends the share token to an API URL so anonymous requests carry it.
export function withShareToken(url: string, token: string | undefined) {
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${shareSearchParam}=${encodeURIComponent(token)}`;
}
