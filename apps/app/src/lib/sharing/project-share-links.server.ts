import type { Db } from "@texfolia/db";
import {
  project,
  projectCollaborator,
  projectShareGrant,
  projectShareLink,
  user,
} from "@texfolia/db/schema";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";

import {
  projectShareLinkEmail,
  type EmailDelivery,
  type EmailNotificationStatus,
} from "#/lib/email";
import {
  invalidateProjectAccess,
  isProjectManager,
  requireProjectManager,
  type LiveProjects,
  type ProjectRole,
  type ProjectTransaction,
} from "#/lib/projects/server";
import { encodeSource } from "#/lib/storage";

import { lockProject, sharePrincipal } from "./project-access.server";
import {
  shareLinkLimit,
  shareTokenSchema,
  type createShareLinkSchema,
  type revokeShareLinkSchema,
} from "./project-share-links.schema";
import { sharePath } from "./share-token";
import { takeSharingEmail } from "./sharing-limit.server";

export async function hashShareToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return encodeSource(new Uint8Array(digest));
}

function createToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeSource(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// Share links follow the collaborator rules: the people who manage the
// project (`isProjectManager`) manage its links.
async function lockManagedProject(
  tx: ProjectTransaction,
  projectId: string,
  userId: string,
) {
  const found = await lockProject({ tx, projectId, userId });
  await requireProjectManager(tx, found, userId).catch(() => {
    throw new Error("Only people who manage this project can manage links.");
  });
  return found;
}

function listLinks(tx: ProjectTransaction, projectId: string) {
  return tx
    .select({
      id: projectShareLink.id,
      role: projectShareLink.role,
      createdAt: projectShareLink.createdAt,
    })
    .from(projectShareLink)
    .where(eq(projectShareLink.projectId, projectId))
    .orderBy(asc(projectShareLink.createdAt));
}

export async function listShareLinks({
  db,
  userId,
  projectId,
}: {
  db: Db;
  userId: string;
  projectId: string;
}) {
  return db.transaction(async (tx) => {
    const found = await lockProject({ tx, projectId, userId, access: "read" });
    if (!(await isProjectManager(tx, found, userId)))
      return { canManage: false, links: [] };
    return { canManage: true, links: await listLinks(tx, projectId) };
  });
}

export async function createShareLink({
  db,
  userId,
  data,
  email,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof createShareLinkSchema>;
  email?: EmailDelivery;
}) {
  const recipientEmail = data.recipientEmail?.trim().toLowerCase();
  const created = await db.transaction(async (tx) => {
    const found = await lockManagedProject(tx, data.projectId, userId);
    const [existing] = await tx
      .select({ count: count() })
      .from(projectShareLink)
      .where(eq(projectShareLink.projectId, data.projectId));
    if ((existing?.count ?? 0) >= shareLinkLimit)
      throw new Error(
        `A project can have at most ${shareLinkLimit} share links. Revoke one first.`,
      );
    let senderName = "Someone";
    if (recipientEmail) {
      const [sender] = await tx
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      if (sender && sender.email.toLowerCase() === recipientEmail)
        throw new Error("You already have access to this project.");
      const [existingCollaborator] = await tx
        .select({ userId: projectCollaborator.userId })
        .from(projectCollaborator)
        .innerJoin(user, eq(projectCollaborator.userId, user.id))
        .where(
          and(
            eq(projectCollaborator.projectId, data.projectId),
            sql`lower(${user.email}) = ${recipientEmail}`,
          ),
        )
        .limit(1);
      if (existingCollaborator)
        throw new Error("That person already has access to this project.");
      await takeSharingEmail(tx, userId);
      senderName = sender?.name ?? senderName;
    }
    const token = createToken();
    const [link] = await tx
      .insert(projectShareLink)
      .values({
        projectId: data.projectId,
        tokenHash: await hashShareToken(token),
        role: data.role,
        createdBy: userId,
      })
      .returning({
        id: projectShareLink.id,
        role: projectShareLink.role,
        createdAt: projectShareLink.createdAt,
      });
    if (!link) throw new Error("Share link could not be created.");
    // The token is returned only here; the database keeps its hash.
    return { link, token, projectName: found.name, senderName };
  });
  let notification: EmailNotificationStatus = "none";
  if (recipientEmail && email) {
    const url = new URL(sharePath(created.token), email.baseURL);
    try {
      await email.send(
        projectShareLinkEmail({
          to: recipientEmail,
          projectName: created.projectName,
          senderName: created.senderName,
          role: created.link.role,
          url,
        }),
      );
      notification = "queued";
    } catch (error) {
      console.error("Failed to queue project share-link email", error);
      notification = "failed";
    }
  }
  return { ...created.link, token: created.token, notification };
}

export async function revokeShareLink({
  db,
  userId,
  data,
  live,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof revokeShareLinkSchema>;
  live?: LiveProjects;
}) {
  await db.transaction(async (tx) => {
    await lockManagedProject(tx, data.projectId, userId);
    // Accounts that redeemed the link lose its grant with it.
    const redeemed = await tx
      .select({ userId: projectShareGrant.userId })
      .from(projectShareGrant)
      .where(eq(projectShareGrant.linkId, data.linkId));
    await tx
      .delete(projectShareLink)
      .where(
        and(
          eq(projectShareLink.projectId, data.projectId),
          eq(projectShareLink.id, data.linkId),
        ),
      );
    // Invalidate before commit so open sockets re-verify behind this lock.
    await invalidateProjectAccess(live, data.projectId, [
      sharePrincipal(data.linkId),
      ...redeemed.map((grant) => grant.userId),
    ]);
  });
}

export async function resolveShareToken(db: Db, token: string) {
  if (!shareTokenSchema.safeParse(token).success) return null;
  const [link] = await db
    .select({
      id: projectShareLink.id,
      projectId: projectShareLink.projectId,
      role: projectShareLink.role,
    })
    .from(projectShareLink)
    .where(eq(projectShareLink.tokenHash, await hashShareToken(token)));
  return link ?? null;
}

export type RedeemedShareLink = {
  projectId: string;
  role: ProjectRole;
  // Comment and edit links need an account; the caller asks them to sign in.
  signIn: boolean;
};

/**
 * Validates a share token for a live project. A signed-in account gets a grant
 * tied to the link, so revoking the link revokes the grant. Without an account
 * nothing is stored: a view link's guest presents the token again, from the
 * share cookie, on every request.
 */
export async function redeemShareLink({
  db,
  token,
  userId,
  live,
}: {
  db: Db;
  token: string;
  userId: string | null;
  live?: LiveProjects;
}): Promise<RedeemedShareLink | null> {
  if (!shareTokenSchema.safeParse(token).success) return null;
  const tokenHash = await hashShareToken(token);
  return db.transaction(async (tx) => {
    // Locking the link and project rows orders this after a revocation or
    // deletion in progress.
    const [link] = await tx
      .select({
        id: projectShareLink.id,
        projectId: projectShareLink.projectId,
        role: projectShareLink.role,
      })
      .from(projectShareLink)
      .innerJoin(
        project,
        and(
          eq(project.id, projectShareLink.projectId),
          isNull(project.deletedAt),
        ),
      )
      .where(eq(projectShareLink.tokenHash, tokenHash))
      .for("share");
    if (!link) return null;
    if (userId === null)
      return {
        projectId: link.projectId,
        role: link.role,
        signIn: link.role !== "viewer",
      };
    const [granted] = await tx
      .insert(projectShareGrant)
      .values({ linkId: link.id, projectId: link.projectId, userId })
      .onConflictDoNothing()
      .returning({ linkId: projectShareGrant.linkId });
    // A socket opened before may have cached less access.
    if (granted) await invalidateProjectAccess(live, link.projectId, [userId]);
    return { projectId: link.projectId, role: link.role, signIn: false };
  });
}

// What an anonymous guest's view-only page shows: the file list and main file.
// Sources and the PDF load from the API with the share cookie.
export async function getSharedProject({
  db,
  token,
  projectId,
}: {
  db: Db;
  token: string;
  projectId: string;
}) {
  const link = await resolveShareToken(db, token);
  if (!link || link.projectId !== projectId || link.role !== "viewer")
    return null;
  return db.transaction(async (tx) => {
    const found = await lockProject({
      tx,
      projectId,
      userId: sharePrincipal(link.id),
      access: "read",
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "Project not found")
        return null;
      throw error;
    });
    if (!found) return null;
    const nodes = await tx.query.projectNode.findMany({
      columns: { id: true, parentId: true, name: true, kind: true },
      where: { projectId, deletedAt: { isNull: true } },
    });
    return {
      projectId: found.id,
      name: found.name,
      mainFile: found.mainFile,
      nodes,
    };
  });
}
