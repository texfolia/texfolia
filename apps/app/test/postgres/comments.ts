import assert from "node:assert/strict";

import { createDb, type Db } from "@texfolia/db";
import {
  projectCollaborator,
  projectCommentThread,
  projectNode,
  user,
} from "@texfolia/db/schema";
import { and, count, eq, inArray } from "drizzle-orm";
import * as Y from "yjs";

import { createCommentAnchor } from "../../src/lib/comments/anchor";
import { maxCommentThreads } from "../../src/lib/comments/project-comments.schema";
import {
  createCommentThread,
  deleteComment,
  deleteCommentThread,
  listComments,
  replyToCommentThread,
  resolveCommentThread,
  updateComment,
} from "../../src/lib/comments/project-comments.server";
import { getProjectMetadata } from "../../src/lib/projects/project-metadata.server";
import { createProject } from "../../src/lib/projects/project.server";
import { sharePrincipal } from "../../src/lib/sharing/project-access.server";

// Review comments follow Google Docs: viewers only read them, commenters add,
// reply, and resolve, authors own their comments, editors moderate, strangers
// and share-link guests see nothing, and every change moves the metadata
// version.
export async function checkComments(db: Db) {
  const [ownerId, editorId, commenterId, viewerId, strangerId] = Array.from(
    { length: 5 },
    () => crypto.randomUUID(),
  );
  assert(ownerId && editorId && commenterId && viewerId && strangerId);
  const ids = [ownerId, editorId, commenterId, viewerId, strangerId];
  await db.insert(user).values(
    ids.map((id, index) => ({
      id,
      name: ["Owner", "Editor", "Commenter", "Viewer", "Stranger"][index] ?? id,
      email: `${id}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  try {
    const created = await createProject({
      db,
      ownerId,
      data: { id: crypto.randomUUID(), name: `Comments ${ownerId}` },
    });
    const projectId = created.id;
    await db.insert(projectCollaborator).values([
      { projectId, userId: editorId, role: "editor" },
      { projectId, userId: commenterId, role: "commenter" },
      { projectId, userId: viewerId, role: "viewer" },
    ]);
    const nodes = await db
      .select()
      .from(projectNode)
      .where(eq(projectNode.projectId, projectId));
    const main = nodes.find((node) => node.name === "main.tex");
    const folder = nodes.find((node) => node.kind === "folder");
    assert(main && folder);

    const doc = new Y.Doc();
    const text = doc.getText("source");
    text.insert(0, "\\section{Results} The effect is large.");
    const anchor = createCommentAnchor(text, 18, 38);
    const version = async () =>
      (await getProjectMetadata({ db, projectId, userId: ownerId }))
        .commentsVersion;
    const initialVersion = await version();
    assert.equal(initialVersion, "0:0:c");

    // Commenters comment even though they cannot edit.
    const { threadId } = await createCommentThread({
      db,
      userId: commenterId,
      data: {
        projectId,
        nodeId: main.id,
        ...anchor,
        quote: "The effect is large.",
        body: "Is this significant?",
      },
    });
    const afterCreate = await version();
    assert.notEqual(afterCreate, initialVersion);

    const asCommenter = await listComments({
      db,
      userId: commenterId,
      projectId,
    });
    assert.equal(asCommenter.canModerate, false);
    assert.equal(asCommenter.canComment, true);
    assert.equal(asCommenter.threads.length, 1);
    const [thread] = asCommenter.threads;
    assert.equal(thread?.anchorStart, anchor.anchorStart);
    assert.equal(thread?.anchorEnd, anchor.anchorEnd);
    assert.equal(thread?.comments[0]?.authorName, "Commenter");
    assert.equal(thread?.comments[0]?.body, "Is this significant?");
    assert.equal(
      (await listComments({ db, userId: ownerId, projectId })).canModerate,
      true,
    );

    // Viewers read comments but cannot add, reply, resolve, edit, or delete.
    const asViewer = await listComments({ db, userId: viewerId, projectId });
    assert.equal(asViewer.canComment, false);
    assert.equal(asViewer.canModerate, false);
    assert.equal(asViewer.threads.length, 1);
    assert.match(
      (await getProjectMetadata({ db, projectId, userId: viewerId }))
        .commentsVersion ?? "",
      /:v$/,
    );
    const viewOnly = /You can only view comments/;
    await assert.rejects(
      createCommentThread({
        db,
        userId: viewerId,
        data: {
          projectId,
          nodeId: main.id,
          ...anchor,
          quote: "The effect is large.",
          body: "Viewers cannot comment",
        },
      }),
      viewOnly,
    );
    await assert.rejects(
      replyToCommentThread({
        db,
        userId: viewerId,
        data: { projectId, threadId, body: "Hi" },
      }),
      viewOnly,
    );
    await assert.rejects(
      resolveCommentThread({
        db,
        userId: viewerId,
        data: { projectId, threadId, resolved: true },
      }),
      viewOnly,
    );
    await assert.rejects(
      deleteCommentThread({
        db,
        userId: viewerId,
        data: { projectId, threadId },
      }),
      viewOnly,
    );

    // People without project access and share-link guests see nothing.
    await assert.rejects(
      listComments({ db, userId: strangerId, projectId }),
      /Project not found/,
    );
    await assert.rejects(
      replyToCommentThread({
        db,
        userId: strangerId,
        data: { projectId, threadId, body: "Hi" },
      }),
      /Project not found/,
    );
    await assert.rejects(
      listComments({
        db,
        userId: sharePrincipal(crypto.randomUUID()),
        projectId,
      }),
      /Project not found/,
    );

    // Threads only attach to live text files, with decodable anchors.
    for (const nodeId of [folder.id, crypto.randomUUID()])
      await assert.rejects(
        createCommentThread({
          db,
          userId: ownerId,
          data: { projectId, nodeId, ...anchor, quote: "", body: "No" },
        }),
        /File not found/,
      );
    await assert.rejects(
      createCommentThread({
        db,
        userId: ownerId,
        data: {
          projectId,
          nodeId: main.id,
          anchorStart: "BQ==",
          anchorEnd: anchor.anchorEnd,
          quote: "",
          body: "No",
        },
      }),
      /range is invalid/,
    );

    // Commenters and editors resolve any thread; a reply reopens.
    await resolveCommentThread({
      db,
      userId: editorId,
      data: { projectId, threadId, resolved: true },
    });
    let listed = await listComments({ db, userId: ownerId, projectId });
    assert(listed.threads[0]?.resolvedAt);
    assert.equal(listed.threads[0]?.resolvedByName, "Editor");
    await replyToCommentThread({
      db,
      userId: ownerId,
      data: { projectId, threadId, body: "Yes, p < 0.01." },
    });
    listed = await listComments({ db, userId: ownerId, projectId });
    assert.equal(listed.threads[0]?.resolvedAt, null);
    assert.deepEqual(
      listed.threads[0]?.comments.map((comment) => comment.authorName),
      ["Commenter", "Owner"],
    );
    await resolveCommentThread({
      db,
      userId: commenterId,
      data: { projectId, threadId, resolved: true },
    });
    await resolveCommentThread({
      db,
      userId: commenterId,
      data: { projectId, threadId, resolved: false },
    });
    listed = await listComments({ db, userId: ownerId, projectId });
    assert.equal(listed.threads[0]?.resolvedAt, null);

    // Only authors edit their comments. Commenters delete only their own;
    // editors also delete other people's.
    const commenterComment = listed.threads[0]?.comments[0];
    const ownerComment = listed.threads[0]?.comments[1];
    assert(commenterComment && ownerComment);
    await assert.rejects(
      updateComment({
        db,
        userId: ownerId,
        data: { projectId, commentId: commenterComment.id, body: "Edited" },
      }),
      /Comment not found/,
    );
    await assert.rejects(
      deleteComment({
        db,
        userId: commenterId,
        data: { projectId, commentId: ownerComment.id },
      }),
      /Comment not found/,
    );
    const beforeEdit = await version();
    await updateComment({
      db,
      userId: commenterId,
      data: {
        projectId,
        commentId: commenterComment.id,
        body: "Is it robust?",
      },
    });
    assert.notEqual(await version(), beforeEdit);
    listed = await listComments({ db, userId: ownerId, projectId });
    assert.equal(listed.threads[0]?.comments[0]?.body, "Is it robust?");
    assert(listed.threads[0]?.comments[0]?.editedAt);
    await deleteComment({
      db,
      userId: ownerId,
      data: { projectId, commentId: ownerComment.id },
    });
    listed = await listComments({ db, userId: ownerId, projectId });
    assert.equal(listed.threads[0]?.comments.length, 1);

    // Deleting a thread's last comment deletes the thread.
    await deleteComment({
      db,
      userId: editorId,
      data: { projectId, commentId: commenterComment.id },
    });
    assert.equal(
      (await listComments({ db, userId: ownerId, projectId })).threads.length,
      0,
    );
    assert.equal(await version(), "0:0:c");

    // A commenter cannot delete someone else's thread; editors can.
    const { threadId: editorThread } = await createCommentThread({
      db,
      userId: editorId,
      data: {
        projectId,
        nodeId: main.id,
        ...anchor,
        quote: "The effect",
        body: "Cite the table.",
      },
    });
    await assert.rejects(
      deleteCommentThread({
        db,
        userId: commenterId,
        data: { projectId, threadId: editorThread },
      }),
      /author or an editor/,
    );
    const { threadId: commenterThread } = await createCommentThread({
      db,
      userId: commenterId,
      data: {
        projectId,
        nodeId: main.id,
        ...anchor,
        quote: "large",
        body: "Typo?",
      },
    });
    await deleteCommentThread({
      db,
      userId: ownerId,
      data: { projectId, threadId: commenterThread },
    });
    await deleteCommentThread({
      db,
      userId: editorId,
      data: { projectId, threadId: editorThread },
    });

    // Concurrent threads cannot pass the project's limit together.
    const [existing] = await db
      .select({ count: count() })
      .from(projectCommentThread)
      .where(eq(projectCommentThread.projectId, projectId));
    await db
      .insert(projectCommentThread)
      .values(
        Array.from(
          { length: maxCommentThreads - 1 - (existing?.count ?? 0) },
          () => ({ projectId, nodeId: main.id, ...anchor, quote: "x" }),
        ),
      );
    const connectionString = db.$client.options.connectionString;
    assert(connectionString);
    const connections = Array.from({ length: 4 }, () =>
      createDb(connectionString),
    );
    const competing = await Promise.allSettled(
      connections.map((connection) =>
        createCommentThread({
          db: connection,
          userId: commenterId,
          data: {
            projectId,
            nodeId: main.id,
            ...anchor,
            quote: "x",
            body: "The last one.",
          },
        }),
      ),
    );
    await Promise.all(connections.map(({ $client }) => $client.end()));
    assert.equal(
      competing.filter((result) => result.status === "fulfilled").length,
      1,
    );
    await db
      .delete(projectCommentThread)
      .where(eq(projectCommentThread.projectId, projectId));

    // Threads on deleted files disappear and stop accepting changes.
    const { threadId: orphan } = await createCommentThread({
      db,
      userId: commenterId,
      data: {
        projectId,
        nodeId: main.id,
        ...anchor,
        quote: "x",
        body: "Kept until the file goes.",
      },
    });
    await db
      .update(projectNode)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectNode.id, main.id)));
    assert.equal(
      (await listComments({ db, userId: commenterId, projectId })).threads
        .length,
      0,
    );
    await assert.rejects(
      replyToCommentThread({
        db,
        userId: commenterId,
        data: { projectId, threadId: orphan, body: "Hello?" },
      }),
      /Comment not found/,
    );
  } finally {
    await db.delete(user).where(inArray(user.id, ids));
  }
}
