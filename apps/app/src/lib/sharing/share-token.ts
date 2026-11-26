// Kept apart from the request schemas so routes do not load Zod.

// 32 random bytes, base64url without padding.
export const shareTokenPattern = /^[A-Za-z0-9_-]{43}$/;

// The link people receive. Opening it redeems the token and redirects to
// `/project/$projectId`, so the token never stays in the address bar.
export function sharePath(token: string) {
  return `/share/${token}`;
}

/**
 * Holds a redeemed token for one project: an anonymous guest's view link, or a
 * comment or edit link waiting for its holder to sign in. HttpOnly, so page
 * scripts never see the token, and checked against the link on every request,
 * so revoking the link ends access immediately.
 */
export function shareCookieName(projectId: string) {
  return `texfolia-share-${projectId}`;
}

// Guests keep view access while they come back within a month.
export const viewCookieMaxAgeSeconds = 30 * 24 * 60 * 60;
// Long enough to sign in or create an account.
export const pendingCookieMaxAgeSeconds = 60 * 60;
