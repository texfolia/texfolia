import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import { projectCollaborator, projectNode, user } from "@texfolia/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import * as Y from "yjs";

import { createCommentAnchor } from "../../src/lib/comments/anchor";
import { sharePrincipal } from "../../src/lib/project-access.server";
import {
  createCommentThread,
  deleteComment,
  deleteCommentThread,
  listComments,
  replyToCommentThread,
  resolveCommentThread,
  updateComment,
} from "../../src/lib/project-comments.server";
import { getProjectMetadata } from "../../src/lib/project-metadata.server";
import { createProject } from "../../src/lib/project.server";

// Review comments: viewers can comment, strangers and share links cannot,
// authors own their comments, and every change moves the metadata version.
export async function checkComments(db: Db) {
  const [ownerId, editorId, viewerId, strangerId] = Array.from(
    { length: 4 },
    () => crypto.randomUUID(),
  );
  assert(ownerId && editorId && viewerId && strangerId);
  const ids = [ownerId, editorId, viewerId, strangerId];
  await db.insert(user).values(
    ids.map((id, index) => ({
      id,
      name: ["Owner", "Editor", "Viewer", "Stranger"][index] ?? id,
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
    assert.equal(initialVersion, "0:0");

    // Viewers comment even though they cannot edit.
    const { threadId } = await createCommentThread({
      db,
      userId: viewerId,
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

    const asViewer = await listComments({ db, userId: viewerId, projectId });
    assert.equal(asViewer.canModerate, false);
    assert.equal(asViewer.threads.length, 1);
    const [thread] = asViewer.threads;
    assert.equal(thread?.anchorStart, anchor.anchorStart);
    assert.equal(thread?.anchorEnd, anchor.anchorEnd);
    assert.equal(thread?.comments[0]?.authorName, "Viewer");
    assert.equal(thread?.comments[0]?.body, "Is this significant?");
    assert.equal(
      (await listComments({ db, userId: ownerId, projectId })).canModerate,
      true,
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

    // Anyone with access resolves; a reply reopens.
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
      ["Viewer", "Owner"],
    );
    await resolveCommentThread({
      db,
      userId: viewerId,
      data: { projectId, threadId, resolved: true },
    });
    await resolveCommentThread({
      db,
      userId: viewerId,
      data: { projectId, threadId, resolved: false },
    });
    listed = await listComments({ db, userId: ownerId, projectId });
    assert.equal(listed.threads[0]?.resolvedAt, null);

    // Only authors edit or delete their own comments.
    const viewerComment = listed.threads[0]?.comments[0];
    const ownerComment = listed.threads[0]?.comments[1];
    assert(viewerComment && ownerComment);
    await assert.rejects(
      updateComment({
        db,
        userId: ownerId,
        data: { projectId, commentId: viewerComment.id, body: "Edited" },
      }),
      /Comment not found/,
    );
    await assert.rejects(
      deleteComment({
        db,
        userId: editorId,
        data: { projectId, commentId: viewerComment.id },
      }),
      /Comment not found/,
    );
    const beforeEdit = await version();
    await updateComment({
      db,
      userId: viewerId,
      data: { projectId, commentId: viewerComment.id, body: "Is it robust?" },
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
      userId: viewerId,
      data: { projectId, commentId: viewerComment.id },
    });
    assert.equal(
      (await listComments({ db, userId: ownerId, projectId })).threads.length,
      0,
    );
    assert.equal(await version(), "0:0");

    // A viewer cannot delete someone else's thread; editors can.
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
        userId: viewerId,
        data: { projectId, threadId: editorThread },
      }),
      /author or an editor/,
    );
    const { threadId: viewerThread } = await createCommentThread({
      db,
      userId: viewerId,
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
      data: { projectId, threadId: viewerThread },
    });
    await deleteCommentThread({
      db,
      userId: editorId,
      data: { projectId, threadId: editorThread },
    });

    // Threads on deleted files disappear and stop accepting changes.
    const { threadId: orphan } = await createCommentThread({
      db,
      userId: viewerId,
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
      (await listComments({ db, userId: viewerId, projectId })).threads.length,
      0,
    );
    await assert.rejects(
      replyToCommentThread({
        db,
        userId: viewerId,
        data: { projectId, threadId: orphan, body: "Hello?" },
      }),
      /Comment not found/,
    );
  } finally {
    await db.delete(user).where(inArray(user.id, ids));
  }
}
