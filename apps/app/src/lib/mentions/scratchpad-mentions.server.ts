import type { Db } from "@texfolia/db";
import { projectScratchpadMention } from "@texfolia/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { EmailDelivery } from "#/lib/email";
import {
  deliverQueuedEmails,
  recordMentionNotifications,
} from "#/lib/notifications/notifications.server";
import {
  lockProject,
  shareLinkIdOf,
} from "#/lib/sharing/project-access.server";

import {
  listProjectAccessiblePeople,
  resolveProjectMentions,
} from "./people.server";
import {
  extractMentionedUserIds,
  mentionExcerpt,
  type ResolvedMention,
} from "./tokens";

/**
 * Reconciles the scratchpad's structured mention tokens against
 * `project_scratchpad_mention`. Only newly added mentions of currently
 * accessible project members trigger notifications (excluding self-mentions).
 */
export async function syncScratchpadMentions({
  db,
  userId,
  projectId,
  body,
  email,
}: {
  db: Db;
  userId: string;
  projectId: string;
  body: string;
  email?: EmailDelivery;
}): Promise<{
  mentionedUserIds: string[];
  notifiedUserIds: string[];
}> {
  if (shareLinkIdOf(userId) !== null) throw new Error("Project not found");
  const { mentionedUserIds, notifiedUserIds, emails } = await db.transaction(
    async (tx) => {
      const found = await lockProject({
        tx,
        projectId,
        userId,
        access: "write",
      });
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`scratchpad-mentions:${projectId}`}, 0))`,
      );
      const accessiblePeople = await listProjectAccessiblePeople(tx, found);
      const validIds = extractMentionedUserIds(body).filter((id) =>
        accessiblePeople.has(id),
      );
      const validSet = new Set(validIds);

      const existingRows = await tx
        .select({ mentionedUserId: projectScratchpadMention.mentionedUserId })
        .from(projectScratchpadMention)
        .where(eq(projectScratchpadMention.projectId, projectId));
      const existingSet = new Set(
        existingRows.map((row) => row.mentionedUserId),
      );

      const added = validIds.filter((id) => !existingSet.has(id));
      const removed = [...existingSet].filter((id) => !validSet.has(id));

      if (removed.length) {
        await tx
          .delete(projectScratchpadMention)
          .where(
            and(
              eq(projectScratchpadMention.projectId, projectId),
              inArray(projectScratchpadMention.mentionedUserId, removed),
            ),
          );
      }
      if (added.length) {
        await tx
          .insert(projectScratchpadMention)
          .values(
            added.map((mentionedUserId) => ({
              projectId,
              mentionedUserId,
              mentionedBy: userId,
            })),
          )
          .onConflictDoNothing();
      }

      const excerpt = mentionExcerpt(
        body,
        (id, fallback) => accessiblePeople.get(id)?.name ?? fallback,
      );
      const queuedEmails = added.length
        ? await recordMentionNotifications({
            tx,
            actorId: userId,
            projectId,
            projectName: found.name,
            kind: "scratchpad_mention",
            recipientIds: added,
            accessiblePeople,
            excerpt,
            emailBaseURL: email?.baseURL,
          })
        : [];
      return {
        mentionedUserIds: validIds,
        notifiedUserIds: added.filter((id) => id !== userId),
        emails: queuedEmails,
      };
    },
  );
  await deliverQueuedEmails(email, emails);
  return { mentionedUserIds, notifiedUserIds };
}

/** Resolves mention user IDs appearing in a project's scratchpad. */
export async function resolveScratchpadMentions({
  db,
  userId,
  projectId,
  userIds,
}: {
  db: Db;
  userId: string;
  projectId: string;
  userIds: readonly string[];
}): Promise<{ mentions: Record<string, ResolvedMention> }> {
  if (shareLinkIdOf(userId) !== null) throw new Error("Project not found");
  return db.transaction(async (tx) => {
    const found = await lockProject({ tx, projectId, userId, access: "read" });
    const mentions = await resolveProjectMentions(tx, found, userIds);
    return { mentions };
  });
}
