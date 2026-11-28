import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import {
  projectCollaborator,
  projectCommentMention,
  projectNode,
  user,
} from "@texfolia/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import * as Y from "yjs";

import { createCommentAnchor } from "../../src/lib/comments/anchor";
import {
  createCommentThread,
  listComments,
  replyToCommentThread,
  updateComment,
} from "../../src/lib/comments/project-comments.server";
import type { EmailMessage } from "../../src/lib/email";
import { listProjectMentionCandidates } from "../../src/lib/mentions/people.server";
import {
  resolveScratchpadMentions,
  syncScratchpadMentions,
} from "../../src/lib/mentions/scratchpad-mentions.server";
import { formatMentionToken } from "../../src/lib/mentions/tokens";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../../src/lib/notifications/notifications.server";
import { createProject } from "../../src/lib/projects/project.server";
import { sharePrincipal } from "../../src/lib/sharing/project-access.server";

export async function checkMentions(db: Db) {
  const [ownerId, editorId, viewerId, formerId, deletedId, strangerId] =
    Array.from({ length: 6 }, () => crypto.randomUUID());
  assert(
    ownerId && editorId && viewerId && formerId && deletedId && strangerId,
  );
  const allIds = [ownerId, editorId, viewerId, formerId, deletedId, strangerId];
  await db.insert(user).values(
    allIds.map((id, index) => ({
      id,
      name:
        ["Owner", "Editor", "Viewer", "Former", "Deleted", "Stranger"][index] ??
        id,
      email: `${id}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );

  const sentEmails: EmailMessage[] = [];
  const email = {
    baseURL: "https://app.texfolia.com",
    async send(message: EmailMessage) {
      sentEmails.push(message);
    },
  };

  try {
    const created = await createProject({
      db,
      ownerId,
      data: { id: crypto.randomUUID(), name: `Mentions ${ownerId}` },
    });
    const projectId = created.id;
    await db.insert(projectCollaborator).values([
      { projectId, userId: editorId, role: "editor" },
      { projectId, userId: viewerId, role: "viewer" },
      { projectId, userId: formerId, role: "commenter" },
      { projectId, userId: deletedId, role: "commenter" },
    ]);

    // 1. Mention candidates: includes owner and all collaborators (including viewers),
    // excludes strangers, never exposes emails, rejects share-link guests.
    const candidates = await listProjectMentionCandidates({
      db,
      userId: viewerId,
      projectId,
    });
    const candidateIds = new Set(candidates.people.map((person) => person.id));
    assert(candidateIds.has(ownerId));
    assert(candidateIds.has(editorId));
    assert(candidateIds.has(viewerId));
    assert(!candidateIds.has(strangerId));
    assert(!("email" in (candidates.people[0] ?? {})));
    await assert.rejects(
      listProjectMentionCandidates({
        db,
        userId: sharePrincipal(crypto.randomUUID()),
        projectId,
      }),
      /Project not found/,
    );

    // 2. Comment mentions: valid mention stored + notified, self-mention ignored,
    // unauthorized user ID sanitized to plain text and never notified.
    const [main] = await db
      .select()
      .from(projectNode)
      .where(
        and(
          eq(projectNode.projectId, projectId),
          eq(projectNode.name, "main.tex"),
        ),
      );
    assert(main);
    const doc = new Y.Doc();
    const text = doc.getText("source");
    text.insert(0, "Check equation 1.");
    const anchor = createCommentAnchor(text, 0, 17);

    const body = [
      `Hi ${formatMentionToken({ id: editorId, name: "Editor" })}`,
      `and ${formatMentionToken({ id: ownerId, name: "Owner" })}`,
      `and ${formatMentionToken({ id: formerId, name: "Former" })}`,
      `and ${formatMentionToken({ id: deletedId, name: "Deleted" })}`,
      `and ${formatMentionToken({ id: strangerId, name: "Stranger" })}`,
    ].join(" ");

    const { threadId } = await createCommentThread({
      db,
      userId: ownerId,
      data: {
        projectId,
        nodeId: main.id,
        ...anchor,
        quote: "Check equation 1.",
        body,
      },
      email,
    });

    // Stranger token was stripped to plain `@Stranger`.
    const loaded = await listComments({ db, userId: ownerId, projectId });
    const firstComment = loaded.threads[0]?.comments[0];
    assert(firstComment);
    assert(!firstComment.body.includes(`mention:${strangerId}`));
    assert(firstComment.body.includes("@Stranger"));

    const storedRows = await db
      .select({ mentionedUserId: projectCommentMention.mentionedUserId })
      .from(projectCommentMention)
      .where(eq(projectCommentMention.commentId, firstComment.id));
    const storedSet = new Set(storedRows.map((row) => row.mentionedUserId));
    assert(storedSet.has(editorId));
    assert(storedSet.has(ownerId));
    assert(!storedSet.has(strangerId));

    // Self-mention produces no notification; editor receives 1 in-app + 1 email.
    const ownerNotifs = await listNotifications({ db, userId: ownerId });
    assert.equal(ownerNotifs.items.length, 0);
    const strangerNotifs = await listNotifications({ db, userId: strangerId });
    assert.equal(strangerNotifs.items.length, 0);
    const editorNotifs = await listNotifications({ db, userId: editorId });
    assert.equal(editorNotifs.unreadCount, 1);
    assert.equal(editorNotifs.items[0]?.kind, "comment_mention");
    assert.equal(editorNotifs.items[0]?.threadId, threadId);
    assert(
      sentEmails.some(
        (msg) =>
          msg.to === `${editorId}@example.com` &&
          msg.text.includes(`?thread=${threadId}`),
      ),
    );
    assert(!sentEmails.some((msg) => msg.to === `${ownerId}@example.com`));
    assert(!sentEmails.some((msg) => msg.to === `${strangerId}@example.com`));

    // 3. Profile rename stays current on render; revoking access shows "Former collaborator";
    // deleting account shows "Deleted user".
    await db
      .update(user)
      .set({ name: "Editor Renamed" })
      .where(eq(user.id, editorId));
    await db
      .delete(projectCollaborator)
      .where(
        and(
          eq(projectCollaborator.projectId, projectId),
          eq(projectCollaborator.userId, formerId),
        ),
      );
    await db.delete(user).where(eq(user.id, deletedId));

    const afterChanges = await listComments({ db, userId: ownerId, projectId });
    assert.equal(afterChanges.mentions[editorId]?.name, "Editor Renamed");
    assert.equal(afterChanges.mentions[editorId]?.status, "active");
    assert.equal(afterChanges.mentions[formerId]?.name, "Former collaborator");
    assert.equal(afterChanges.mentions[formerId]?.status, "former");
    assert.equal(afterChanges.mentions[deletedId]?.name, "Deleted user");
    assert.equal(afterChanges.mentions[deletedId]?.status, "deleted");

    // Revoked user no longer sees project notifications.
    const formerNotifs = await listNotifications({ db, userId: formerId });
    assert.equal(formerNotifs.items.length, 0);

    // 4. Editing a comment only notifies newly added mentions (not existing ones).
    const emailsBeforeEdit = sentEmails.length;
    await updateComment({
      db,
      userId: ownerId,
      data: {
        projectId,
        commentId: firstComment.id,
        body: `${firstComment.body} cc ${formatMentionToken({ id: viewerId, name: "Viewer" })}`,
      },
      email,
    });
    const editorNotifsAfterEdit = await listNotifications({
      db,
      userId: editorId,
    });
    assert.equal(editorNotifsAfterEdit.items.length, 1);
    const viewerNotifs = await listNotifications({ db, userId: viewerId });
    assert.equal(viewerNotifs.unreadCount, 1);
    assert.equal(sentEmails.length, emailsBeforeEdit + 1);

    // 5. Replying with a mention notifies the mentioned user.
    await replyToCommentThread({
      db,
      userId: editorId,
      data: {
        projectId,
        threadId,
        body: `Thanks ${formatMentionToken({ id: ownerId, name: "Owner" })}!`,
      },
      email,
    });
    const ownerAfterReply = await listNotifications({ db, userId: ownerId });
    assert.equal(ownerAfterReply.unreadCount, 1);

    // 6. Scratchpad mention sync: rejects viewers, deduplicates across edits,
    // notifies newly added mentions only, and resolves historical mentions.
    await assert.rejects(
      syncScratchpadMentions({
        db,
        userId: viewerId,
        projectId,
        body: formatMentionToken({ id: ownerId, name: "Owner" }),
      }),
    );

    const scratchpadBody = `TODO: ask ${formatMentionToken({ id: editorId, name: "Editor" })} and ${formatMentionToken({ id: ownerId, name: "Owner" })} and ${formatMentionToken({ id: strangerId, name: "Stranger" })}`;
    const firstSync = await syncScratchpadMentions({
      db,
      userId: ownerId,
      projectId,
      body: scratchpadBody,
      email,
    });
    assert.deepEqual(firstSync.notifiedUserIds, [editorId]);
    assert(!firstSync.mentionedUserIds.includes(strangerId));

    // Re-syncing the same mentions must not create duplicate notifications.
    const secondSync = await syncScratchpadMentions({
      db,
      userId: ownerId,
      projectId,
      body: `${scratchpadBody}\nMore notes.`,
      email,
    });
    assert.deepEqual(secondSync.notifiedUserIds, []);

    const editorAfterScratchpad = await listNotifications({
      db,
      userId: editorId,
    });
    assert.equal(editorAfterScratchpad.items.length, 2);
    assert.equal(editorAfterScratchpad.items[0]?.kind, "scratchpad_mention");

    const resolvedScratchpad = await resolveScratchpadMentions({
      db,
      userId: ownerId,
      projectId,
      userIds: [editorId, formerId, deletedId],
    });
    assert.equal(resolvedScratchpad.mentions[editorId]?.name, "Editor Renamed");
    assert.equal(resolvedScratchpad.mentions[formerId]?.status, "former");
    assert.equal(resolvedScratchpad.mentions[deletedId]?.status, "deleted");

    // 7. Marking notifications read (single + all).
    const firstNotifId = editorAfterScratchpad.items[0]?.id;
    assert(firstNotifId);
    await markNotificationRead({
      db,
      userId: editorId,
      notificationId: firstNotifId,
    });
    assert.equal(
      (await listNotifications({ db, userId: editorId })).unreadCount,
      1,
    );
    await markAllNotificationsRead({ db, userId: editorId });
    assert.equal(
      (await listNotifications({ db, userId: editorId })).unreadCount,
      0,
    );
  } finally {
    await db.delete(user).where(inArray(user.id, allIds));
  }
}
