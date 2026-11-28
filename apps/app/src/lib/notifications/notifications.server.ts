import type { Db } from "@texfolia/db";
import { project, user, userNotification } from "@texfolia/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";

import {
  mentionEmail,
  type EmailDelivery,
  type EmailMessage,
} from "#/lib/email";
import type { AccessibleProjectPerson } from "#/lib/mentions/people.server";
import type { ProjectTransaction } from "#/lib/projects/server";
import {
  lockProjectReaders,
  shareLinkIdOf,
} from "#/lib/sharing/project-access.server";
import { tryTakeSharingEmail } from "#/lib/sharing/sharing-limit.server";

export type NotificationKind = "comment_mention" | "scratchpad_mention";

export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  projectId: string;
  projectName: string;
  threadId: string | null;
  commentId: string | null;
  actorId: string | null;
  actorName: string;
  actorImage: string | null;
  excerpt: string;
  readAt: Date | null;
  createdAt: Date;
};

/**
 * Inserts in-app notifications for newly mentioned project collaborators
 * (excluding self-mentions) and builds outbound email messages subject to the
 * actor's sharing email budget. Call `deliverQueuedEmails` after the
 * transaction commits.
 */
export async function recordMentionNotifications({
  tx,
  actorId,
  projectId,
  projectName,
  kind,
  threadId = null,
  commentId = null,
  recipientIds,
  accessiblePeople,
  excerpt,
  emailBaseURL,
}: {
  tx: ProjectTransaction;
  actorId: string;
  projectId: string;
  projectName: string;
  kind: NotificationKind;
  threadId?: string | null;
  commentId?: string | null;
  recipientIds: readonly string[];
  accessiblePeople: ReadonlyMap<string, AccessibleProjectPerson>;
  excerpt: string;
  emailBaseURL?: string;
}): Promise<EmailMessage[]> {
  const recipients: AccessibleProjectPerson[] = [];
  const seen = new Set<string>();
  for (const id of recipientIds) {
    if (id === actorId || seen.has(id)) continue;
    const person = accessiblePeople.get(id);
    if (!person) continue;
    seen.add(id);
    recipients.push(person);
  }
  if (!recipients.length) return [];

  await tx.insert(userNotification).values(
    recipients.map((person) => ({
      userId: person.id,
      actorId,
      kind,
      projectId,
      threadId,
      commentId,
      excerpt,
    })),
  );

  if (!emailBaseURL) return [];
  const actor = accessiblePeople.get(actorId);
  const actorName = actor?.name ?? "Someone";
  const path =
    kind === "comment_mention" && threadId
      ? `/project/${encodeURIComponent(projectId)}?thread=${encodeURIComponent(threadId)}`
      : `/project/${encodeURIComponent(projectId)}?view=scratchpad`;
  const url = new URL(path, emailBaseURL);
  const surface = kind === "comment_mention" ? "comment" : "scratchpad";

  const emails: EmailMessage[] = [];
  for (const person of recipients) {
    if (!person.email) continue;
    const allowed = await tryTakeSharingEmail(tx, actorId);
    if (!allowed) break;
    emails.push(
      mentionEmail({
        to: person.email,
        actorName,
        projectName,
        surface,
        excerpt,
        url,
      }),
    );
  }
  return emails;
}

/** Queues mention emails outside the database transaction. */
export async function deliverQueuedEmails(
  email: EmailDelivery | undefined,
  messages: readonly EmailMessage[],
) {
  if (!email || !messages.length) return;
  for (const message of messages) {
    try {
      await email.send(message);
    } catch (error) {
      console.error("Failed to queue mention email", error);
    }
  }
}

/** Lists recent notifications for the signed-in user across accessible projects. */
export async function listNotifications({
  db,
  userId,
  limit = 30,
}: {
  db: Db;
  userId: string;
  limit?: number;
}): Promise<{ items: NotificationItem[]; unreadCount: number }> {
  if (shareLinkIdOf(userId) !== null) return { items: [], unreadCount: 0 };
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: userNotification.id,
        kind: userNotification.kind,
        projectId: userNotification.projectId,
        projectName: project.name,
        threadId: userNotification.threadId,
        commentId: userNotification.commentId,
        actorId: userNotification.actorId,
        actorName: user.name,
        actorImage: user.image,
        excerpt: userNotification.excerpt,
        readAt: userNotification.readAt,
        createdAt: userNotification.createdAt,
      })
      .from(userNotification)
      .innerJoin(project, eq(project.id, userNotification.projectId))
      .leftJoin(user, eq(user.id, userNotification.actorId))
      .where(
        and(eq(userNotification.userId, userId), isNull(project.deletedAt)),
      )
      .orderBy(desc(userNotification.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100));

    // Only expose notifications for projects the user still has access to.
    const distinctProjects = [...new Set(rows.map((row) => row.projectId))];
    const accessibleProjects = new Set<string>();
    for (const projectId of distinctProjects) {
      const readers = await lockProjectReaders({
        tx,
        projectId,
        userIds: [userId],
      });
      if (readers.has(userId)) accessibleProjects.add(projectId);
    }

    const items: NotificationItem[] = rows
      .filter((row) => accessibleProjects.has(row.projectId))
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        projectId: row.projectId,
        projectName: row.projectName,
        threadId: row.threadId,
        commentId: row.commentId,
        actorId: row.actorId,
        actorName: row.actorName ?? "Deleted user",
        actorImage: row.actorImage ?? null,
        excerpt: row.excerpt,
        readAt: row.readAt,
        createdAt: row.createdAt,
      }));
    const unreadCount = items.filter((item) => item.readAt === null).length;
    return { items, unreadCount };
  });
}

export async function markNotificationRead({
  db,
  userId,
  notificationId,
}: {
  db: Db;
  userId: string;
  notificationId: string;
}) {
  if (shareLinkIdOf(userId) !== null) return;
  await db
    .update(userNotification)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(userNotification.id, notificationId),
        eq(userNotification.userId, userId),
        isNull(userNotification.readAt),
      ),
    );
}

export async function markAllNotificationsRead({
  db,
  userId,
}: {
  db: Db;
  userId: string;
}) {
  if (shareLinkIdOf(userId) !== null) return;
  await db
    .update(userNotification)
    .set({ readAt: new Date() })
    .where(
      and(eq(userNotification.userId, userId), isNull(userNotification.readAt)),
    );
}
