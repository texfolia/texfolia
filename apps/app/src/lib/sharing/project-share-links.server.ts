import type { Db } from "@texfolia/db";
import {
  projectCollaborator,
  projectShareLink,
  user,
} from "@texfolia/db/schema";
import { and, asc, count, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import {
  invalidateCollaborationAccess,
  type CollaborationAccess,
} from "#/lib/collaboration/server";
import {
  projectShareLinkEmail,
  type EmailDelivery,
  type EmailNotificationStatus,
} from "#/lib/email";
import type { ProjectTransaction } from "#/lib/projects/server";
import { encodeSource } from "#/lib/storage";

import { lockProject, sharePrincipal } from "./project-access.server";
import {
  shareLinkLimit,
  sharePath,
  shareTokenSchema,
  type createShareLinkSchema,
  type revokeShareLinkSchema,
} from "./project-share-links.schema";

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

// Share links follow the collaborator rules: only a personal project's owner
// manages them. Organization projects have no share links in v1.
async function lockManagedProject(
  tx: ProjectTransaction,
  projectId: string,
  userId: string,
) {
  const found = await lockProject({ tx, projectId, userId });
  if (found.organizationId || found.ownerId !== userId)
    throw new Error("Only the project owner can manage share links.");
  return found;
}

function listLinks(tx: ProjectTransaction, projectId: string) {
  return tx
    .select({
      id: projectShareLink.id,
      scope: projectShareLink.scope,
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
    if (found.organizationId || found.ownerId !== userId)
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
      const [owner] = await tx
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      if (owner && owner.email.toLowerCase() === recipientEmail)
        throw new Error("You already own this project.");
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
      senderName = owner?.name ?? senderName;
    }
    const token = createToken();
    const [link] = await tx
      .insert(projectShareLink)
      .values({
        projectId: data.projectId,
        tokenHash: await hashShareToken(token),
        scope: data.scope,
        createdBy: userId,
      })
      .returning({
        id: projectShareLink.id,
        scope: projectShareLink.scope,
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
          scope: created.link.scope,
          url,
        }),
      );
      notification = "sent";
    } catch (error) {
      console.error("Failed to send project share-link email", error);
      notification = "failed";
    }
  }
  return { ...created.link, token: created.token, notification };
}

export async function revokeShareLink({
  db,
  userId,
  data,
  collaboration,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof revokeShareLinkSchema>;
  collaboration?: CollaborationAccess;
}) {
  await db.transaction(async (tx) => {
    await lockManagedProject(tx, data.projectId, userId);
    await tx
      .delete(projectShareLink)
      .where(
        and(
          eq(projectShareLink.projectId, data.projectId),
          eq(projectShareLink.id, data.linkId),
        ),
      );
    // Invalidate before commit so open sockets re-verify behind this lock.
    // Live build streams re-check access on their own interval.
    await invalidateCollaborationAccess(collaboration, data.projectId, [
      sharePrincipal(data.linkId),
    ]);
  });
}

export async function resolveShareToken(db: Db, token: string) {
  if (!shareTokenSchema.safeParse(token).success) return null;
  const [link] = await db
    .select({
      id: projectShareLink.id,
      projectId: projectShareLink.projectId,
      scope: projectShareLink.scope,
    })
    .from(projectShareLink)
    .where(eq(projectShareLink.tokenHash, await hashShareToken(token)));
  return link ?? null;
}

export async function getSharedProject({
  db,
  token,
}: {
  db: Db;
  token: string;
}) {
  const link = await resolveShareToken(db, token);
  if (!link) throw new Error("Share link not found");
  return db.transaction(async (tx) => {
    const found = await lockProject({
      tx,
      projectId: link.projectId,
      userId: sharePrincipal(link.id),
      access: "read",
      content: link.scope === "pdf" ? "build" : "sources",
    });
    const nodes =
      link.scope === "project"
        ? await tx.query.projectNode.findMany({
            columns: { id: true, parentId: true, name: true, kind: true },
            where: { projectId: link.projectId, deletedAt: { isNull: true } },
          })
        : [];
    return {
      projectId: found.id,
      name: found.name,
      scope: link.scope,
      nodes,
    };
  });
}
