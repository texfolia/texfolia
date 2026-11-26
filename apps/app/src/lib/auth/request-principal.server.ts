import type { Db } from "@texfolia/db";

import { sharePrincipal } from "#/lib/sharing/project-access.server";
import { resolveShareToken } from "#/lib/sharing/project-share-links.server";
import { readShareCookie } from "#/lib/sharing/share-cookie.server";

import type { createAuth } from "./auth";

export type RequestPrincipal = {
  userId: string;
  name: string;
  share: boolean;
};

// Resolves who is asking for a project resource. A signed-in account acts as
// itself; share links it redeemed are grants on that account. Without a
// session, a redeemed view link's cookie for this project makes an anonymous
// guest. Callers still check access with lockProject.
export async function requestPrincipal({
  request,
  auth,
  db,
  projectId,
}: {
  request: Request;
  auth: ReturnType<typeof createAuth>;
  db: Db;
  projectId: string;
}): Promise<RequestPrincipal | null> {
  const session = await auth.api.getSession({
    headers: request.headers,
    // A live connection outlasts the cached session. Reading the database also
    // sets no cookie, which Start could only add by rebuilding the response, and
    // a WebSocket upgrade cannot be rebuilt.
    query: request.headers.has("Upgrade")
      ? { disableCookieCache: true, disableRefresh: true }
      : {},
  });
  if (session)
    return { userId: session.user.id, name: session.user.name, share: false };
  const token = readShareCookie(request.headers.get("Cookie"), projectId);
  if (token === null) return null;
  const link = await resolveShareToken(db, token);
  // Comment and edit links wait in the cookie until their holder signs in.
  if (!link || link.projectId !== projectId || link.role !== "viewer")
    return null;
  return { userId: sharePrincipal(link.id), name: "Guest", share: true };
}
