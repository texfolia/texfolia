import type { Db } from "@texfolia/db";
import {
  projectComment,
  projectCommentThread,
  projectNode,
  user,
} from "@texfolia/db/schema";
import { and, asc, count, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";

import { notifyProjectCommentChanged } from "#/lib/builds/client";
import type { ProjectTransaction } from "#/lib/projects/server";
import {
  lockProject,
  shareLinkIdOf,
} from "#/lib/sharing/project-access.server";

import { decodeCommentPosition } from "./anchor";
import {
  maxCommentThreads,
  maxThreadComments,
  type createCommentThreadSchema,
  type deleteCommentSchema,
  type deleteCommentThreadSchema,
  type replyToCommentThreadSchema,
  type resolveCommentThreadSchema,
  type updateCommentSchema,
} from "./project-comments.schema";

// Google Docs rules: viewers read comments; commenters also add, reply, resolve
// and reopen any thread, and edit or delete their own comments; editors also
// delete anyone's. Anonymous share-link guests have no account, so they can
// neither read nor write comments.
async function lockForComments(
  tx: ProjectTransaction,
  projectId: string,
  userId: string,
  access: "read" | "comment" = "comment",
) {
  if (shareLinkIdOf(userId) !== null) throw new Error("Project not found");
  const found = await lockProject({ tx, projectId, userId, access: "read" });
  if (access === "comment" && !found.canComment)
    throw new Error("You can only view comments on this project.");
  return found;
}

// Threads on deleted files are hidden and cannot change. The row lock
// serializes concurrent changes to one thread.
async function lockThread(
  tx: ProjectTransaction,
  projectId: string,
  threadId: string,
) {
  const [thread] = await tx
    .select({
      id: projectCommentThread.id,
      createdBy: projectCommentThread.createdBy,
    })
    .from(projectCommentThread)
    .innerJoin(projectNode, eq(projectNode.id, projectCommentThread.nodeId))
    .where(
      and(
        eq(projectCommentThread.id, threadId),
        eq(projectCommentThread.projectId, projectId),
        isNull(projectNode.deletedAt),
      ),
    )
    .for("update", { of: projectCommentThread });
  if (!thread) throw new Error("Comment not found");
  return thread;
}

function touchThread(tx: ProjectTransaction, threadId: string) {
  return tx
    .update(projectCommentThread)
    .set({ updatedAt: sql`now()` })
    .where(eq(projectCommentThread.id, threadId));
}

// Locks a comment written by `authorId`, or by anyone when it is null; other
// people's comments are not found.
async function lockComment(
  tx: ProjectTransaction,
  projectId: string,
  commentId: string,
  authorId: string | null,
) {
  const [found] = await tx
    .select({ threadId: projectComment.threadId })
    .from(projectComment)
    .where(
      and(
        eq(projectComment.id, commentId),
        authorId === null ? undefined : eq(projectComment.authorId, authorId),
      ),
    );
  if (!found) throw new Error("Comment not found");
  await lockThread(tx, projectId, found.threadId);
  return found;
}

export async function listComments({
  db,
  userId,
  projectId,
}: {
  db: Db;
  userId: string;
  projectId: string;
}) {
  return db.transaction(async (tx) => {
    const { canWrite, canComment } = await lockForComments(
      tx,
      projectId,
      userId,
      "read",
    );
    const resolver = alias(user, "resolver");
    const threads = await tx
      .select({
        id: projectCommentThread.id,
        nodeId: projectCommentThread.nodeId,
        anchorStart: projectCommentThread.anchorStart,
        anchorEnd: projectCommentThread.anchorEnd,
        quote: projectCommentThread.quote,
        createdBy: projectCommentThread.createdBy,
        createdAt: projectCommentThread.createdAt,
        resolvedAt: projectCommentThread.resolvedAt,
        resolvedByName: resolver.name,
      })
      .from(projectCommentThread)
      .innerJoin(projectNode, eq(projectNode.id, projectCommentThread.nodeId))
      .leftJoin(resolver, eq(resolver.id, projectCommentThread.resolvedBy))
      .where(
        and(
          eq(projectCommentThread.projectId, projectId),
          isNull(projectNode.deletedAt),
        ),
      )
      .orderBy(asc(projectCommentThread.createdAt));
    const comments = threads.length
      ? await tx
          .select({
            id: projectComment.id,
            threadId: projectComment.threadId,
            authorId: projectComment.authorId,
            authorName: user.name,
            authorImage: user.image,
            body: projectComment.body,
            createdAt: projectComment.createdAt,
            editedAt: projectComment.editedAt,
          })
          .from(projectComment)
          .innerJoin(user, eq(user.id, projectComment.authorId))
          .where(
            inArray(
              projectComment.threadId,
              threads.map((thread) => thread.id),
            ),
          )
          .orderBy(asc(projectComment.createdAt), asc(projectComment.id))
      : [];
    const byThread = new Map<string, typeof comments>();
    for (const comment of comments) {
      const items = byThread.get(comment.threadId);
      if (items) items.push(comment);
      else byThread.set(comment.threadId, [comment]);
    }
    return {
      userId,
      canComment,
      canModerate: canWrite,
      // A thread whose every comment was deleted with its author's account
      // has nothing left to show.
      threads: threads.flatMap((thread) => {
        const items = byThread.get(thread.id);
        return items ? [{ ...thread, comments: items }] : [];
      }),
    };
  });
}

export type CommentThreads = Awaited<ReturnType<typeof listComments>>;
export type CommentThread = CommentThreads["threads"][number];

/** Loads a single comment thread and its comments, or null if deleted. */
export async function getCommentThread({
  db,
  userId,
  projectId,
  threadId,
}: {
  db: Db;
  userId: string;
  projectId: string;
  threadId: string;
}): Promise<{
  userId: string;
  canComment: boolean;
  canModerate: boolean;
  thread: CommentThread | null;
}> {
  return db.transaction(async (tx) => {
    const { canWrite, canComment } = await lockForComments(
      tx,
      projectId,
      userId,
      "read",
    );
    const resolver = alias(user, "resolver");
    const [thread] = await tx
      .select({
        id: projectCommentThread.id,
        nodeId: projectCommentThread.nodeId,
        anchorStart: projectCommentThread.anchorStart,
        anchorEnd: projectCommentThread.anchorEnd,
        quote: projectCommentThread.quote,
        createdBy: projectCommentThread.createdBy,
        createdAt: projectCommentThread.createdAt,
        resolvedAt: projectCommentThread.resolvedAt,
        resolvedByName: resolver.name,
      })
      .from(projectCommentThread)
      .innerJoin(projectNode, eq(projectNode.id, projectCommentThread.nodeId))
      .leftJoin(resolver, eq(resolver.id, projectCommentThread.resolvedBy))
      .where(
        and(
          eq(projectCommentThread.id, threadId),
          eq(projectCommentThread.projectId, projectId),
          isNull(projectNode.deletedAt),
        ),
      );
    if (!thread)
      return { userId, canComment, canModerate: canWrite, thread: null };
    const comments = await tx
      .select({
        id: projectComment.id,
        threadId: projectComment.threadId,
        authorId: projectComment.authorId,
        authorName: user.name,
        authorImage: user.image,
        body: projectComment.body,
        createdAt: projectComment.createdAt,
        editedAt: projectComment.editedAt,
      })
      .from(projectComment)
      .innerJoin(user, eq(user.id, projectComment.authorId))
      .where(eq(projectComment.threadId, thread.id))
      .orderBy(asc(projectComment.createdAt), asc(projectComment.id));
    return {
      userId,
      canComment,
      canModerate: canWrite,
      thread: comments.length ? { ...thread, comments } : null,
    };
  });
}

// A version of the project's comments for the workspace metadata poll. Every
// change bumps a thread's updatedAt or changes the thread count. It also
// changes with whether the viewer may comment, so the panel reloads when
// their role does.
export async function commentsVersion(
  tx: ProjectTransaction,
  projectId: string,
  canComment: boolean,
) {
  const [row] = await tx
    .select({
      threads: count(),
      updatedAt: max(projectCommentThread.updatedAt),
    })
    .from(projectCommentThread)
    .where(eq(projectCommentThread.projectId, projectId));
  return `${row?.threads ?? 0}:${row?.updatedAt?.getTime() ?? 0}:${canComment ? "c" : "v"}`;
}

export async function createCommentThread({
  db,
  userId,
  data,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof createCommentThreadSchema>;
}) {
  if (
    !decodeCommentPosition(data.anchorStart) ||
    !decodeCommentPosition(data.anchorEnd)
  )
    throw new Error("The comment range is invalid. Select the text again.");
  const created = await db.transaction(async (tx) => {
    await lockForComments(tx, data.projectId, userId);
    const [node] = await tx
      .select({ id: projectNode.id })
      .from(projectNode)
      .where(
        and(
          eq(projectNode.id, data.nodeId),
          eq(projectNode.projectId, data.projectId),
          eq(projectNode.kind, "text"),
          isNull(projectNode.deletedAt),
        ),
      );
    if (!node) throw new Error("File not found");
    // Commenters hold the project lock in shared mode, so it does not
    // serialize the count.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`comment-threads:${data.projectId}`}, 0))`,
    );
    const [existing] = await tx
      .select({ count: count() })
      .from(projectCommentThread)
      .where(eq(projectCommentThread.projectId, data.projectId));
    if ((existing?.count ?? 0) >= maxCommentThreads)
      throw new Error(
        `A project can have at most ${maxCommentThreads} comment threads. Delete resolved threads first.`,
      );
    const [thread] = await tx
      .insert(projectCommentThread)
      .values({
        projectId: data.projectId,
        nodeId: data.nodeId,
        anchorStart: data.anchorStart,
        anchorEnd: data.anchorEnd,
        quote: data.quote,
        createdBy: userId,
      })
      .returning({ id: projectCommentThread.id });
    if (!thread) throw new Error("Comment could not be created.");
    await tx
      .insert(projectComment)
      .values({ threadId: thread.id, authorId: userId, body: data.body });
    return { threadId: thread.id };
  });
  await notifyProjectCommentChanged(data.projectId, created.threadId);
  return created;
}

export async function replyToCommentThread({
  db,
  userId,
  data,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof replyToCommentThreadSchema>;
}) {
  const created = await db.transaction(async (tx) => {
    await lockForComments(tx, data.projectId, userId);
    await lockThread(tx, data.projectId, data.threadId);
    const [existing] = await tx
      .select({ count: count() })
      .from(projectComment)
      .where(eq(projectComment.threadId, data.threadId));
    if ((existing?.count ?? 0) >= maxThreadComments)
      throw new Error(
        `A thread can have at most ${maxThreadComments} comments. Start a new thread.`,
      );
    const [comment] = await tx
      .insert(projectComment)
      .values({ threadId: data.threadId, authorId: userId, body: data.body })
      .returning({ id: projectComment.id });
    // Replying to a resolved thread reopens it.
    await tx
      .update(projectCommentThread)
      .set({ resolvedAt: null, resolvedBy: null, updatedAt: sql`now()` })
      .where(eq(projectCommentThread.id, data.threadId));
    return { commentId: comment?.id };
  });
  await notifyProjectCommentChanged(data.projectId, data.threadId);
  return created;
}

export async function resolveCommentThread({
  db,
  userId,
  data,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof resolveCommentThreadSchema>;
}) {
  await db.transaction(async (tx) => {
    await lockForComments(tx, data.projectId, userId);
    await lockThread(tx, data.projectId, data.threadId);
    await tx
      .update(projectCommentThread)
      .set(
        data.resolved
          ? {
              resolvedAt: sql`now()`,
              resolvedBy: userId,
              updatedAt: sql`now()`,
            }
          : { resolvedAt: null, resolvedBy: null, updatedAt: sql`now()` },
      )
      .where(eq(projectCommentThread.id, data.threadId));
  });
  await notifyProjectCommentChanged(data.projectId, data.threadId);
}

// The thread's author, if they can still comment, and project editors can
// delete a whole thread.
export async function deleteCommentThread({
  db,
  userId,
  data,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof deleteCommentThreadSchema>;
}) {
  await db.transaction(async (tx) => {
    const { canWrite } = await lockForComments(tx, data.projectId, userId);
    const thread = await lockThread(tx, data.projectId, data.threadId);
    if (!canWrite && thread.createdBy !== userId)
      throw new Error("Only the thread's author or an editor can delete it.");
    await tx
      .delete(projectCommentThread)
      .where(eq(projectCommentThread.id, data.threadId));
  });
  await notifyProjectCommentChanged(data.projectId, data.threadId);
}

export async function updateComment({
  db,
  userId,
  data,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof updateCommentSchema>;
}) {
  const threadId = await db.transaction(async (tx) => {
    await lockForComments(tx, data.projectId, userId);
    const { threadId } = await lockComment(
      tx,
      data.projectId,
      data.commentId,
      userId,
    );
    await tx
      .update(projectComment)
      .set({ body: data.body, editedAt: sql`now()` })
      .where(eq(projectComment.id, data.commentId));
    await touchThread(tx, threadId);
    return threadId;
  });
  await notifyProjectCommentChanged(data.projectId, threadId);
}

// Authors delete their own comments, and editors anyone's. Deleting a thread's
// last comment deletes the thread.
export async function deleteComment({
  db,
  userId,
  data,
}: {
  db: Db;
  userId: string;
  data: z.infer<typeof deleteCommentSchema>;
}) {
  const threadId = await db.transaction(async (tx) => {
    const { canWrite } = await lockForComments(tx, data.projectId, userId);
    const { threadId } = await lockComment(
      tx,
      data.projectId,
      data.commentId,
      canWrite ? null : userId,
    );
    await tx
      .delete(projectComment)
      .where(eq(projectComment.id, data.commentId));
    const [remaining] = await tx
      .select({ count: count() })
      .from(projectComment)
      .where(eq(projectComment.threadId, threadId));
    if (remaining?.count) await touchThread(tx, threadId);
    else
      await tx
        .delete(projectCommentThread)
        .where(eq(projectCommentThread.id, threadId));
    return threadId;
  });
  await notifyProjectCommentChanged(data.projectId, threadId);
}
