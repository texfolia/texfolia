// Kept apart from the request schemas so routes do not load Zod.

// 32 random bytes, base64url without padding.
export const shareTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export const shareSearchParam = "share";

export function sharePath(token: string) {
  return `/share/${token}`;
}

// Appends the share token to an API URL so anonymous requests carry it.
export function withShareToken(url: string, token: string | undefined) {
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${shareSearchParam}=${encodeURIComponent(token)}`;
}
