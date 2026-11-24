import type { Db } from "@texfolia/db";

import { sharePrincipal } from "#/lib/sharing/project-access.server";
import { shareSearchParam } from "#/lib/sharing/project-share-links.schema";
import { resolveShareToken } from "#/lib/sharing/project-share-links.server";

import type { createAuth } from "./auth";

export type RequestPrincipal = {
  userId: string;
  name: string;
  share: boolean;
};

// Resolves who is asking for a project resource. A share token in the URL
// takes precedence over the session, so a share page behaves the same whether
// or not its viewer is signed in. Callers still check access with lockProject.
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
  const token = new URL(request.url).searchParams.get(shareSearchParam);
  if (token !== null) {
    const link = await resolveShareToken(db, token);
    if (!link || link.projectId !== projectId) return null;
    return { userId: sharePrincipal(link.id), name: "Guest", share: true };
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  return { userId: session.user.id, name: session.user.name, share: false };
}
