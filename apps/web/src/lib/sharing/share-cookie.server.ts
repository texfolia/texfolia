import {
  pendingCookieMaxAgeSeconds,
  shareCookieName,
  viewCookieMaxAgeSeconds,
} from "./share-token";

// The share cookie's value, from a `Cookie` header.
export function readShareCookie(header: string | null, projectId: string) {
  if (!header) return null;
  const name = shareCookieName(projectId);
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

// Lax so the cookie survives the redirect from the link and following a link
// from email; the socket and API checks also compare the Origin header.
function attributes(secure: boolean) {
  return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Set-Cookie for a redeemed token. Pending links expire sooner. */
export function shareCookie(
  projectId: string,
  token: string,
  { pending, secure }: { pending: boolean; secure: boolean },
) {
  const maxAge = pending ? pendingCookieMaxAgeSeconds : viewCookieMaxAgeSeconds;
  return `${shareCookieName(projectId)}=${token}; Max-Age=${maxAge}; ${attributes(secure)}`;
}

export function clearShareCookie(projectId: string, secure: boolean) {
  return `${shareCookieName(projectId)}=; Max-Age=0; ${attributes(secure)}`;
}
