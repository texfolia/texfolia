import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectCollaborator,
  projectCollaboration,
  projectNode,
  user,
} from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import type { Miniflare } from "miniflare";
import * as Y from "yjs";

import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "#/features/collaboration";
import { hashSource } from "#/features/compile";

import { createProject } from "../../src/features/projects/project.server";

async function eventually(
  check: () => Promise<boolean> | boolean,
  label: string,
) {
  const deadline = Date.now() + 12_000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function checkDeletion({
  mf,
  db,
  origin,
  ownerId,
  cookie,
}: {
  mf: Miniflare;
  db: Db;
  origin: string;
  ownerId: string;
  cookie: string;
}) {
  const bucket = await mf.getR2Bucket("SOURCES");
  const storageFor = (projectId: string) =>
    mf.unsafeGetDurableObjectStorage(
      "collaboration-test",
      "ProjectCollaboration",
      { name: projectId },
    );
  async function cleanup(path: string, status = 204) {
    const response = await mf.dispatchFetch(`${origin}/cleanup/${path}`, {
      method: "POST",
      headers: { "X-Owner": ownerId },
    });
    assert.equal(response.status, status, `Cleanup ${path}`);
  }
  async function registered(projectId: string) {
    return (
      (
        await db
          .select()
          .from(projectCollaboration)
          .where(eq(projectCollaboration.projectId, projectId))
      ).length === 1
    );
  }
  async function empty(projectId: string) {
    const storage = await storageFor(projectId);
    for (const table of [
      "documents",
      "updates",
      "snapshot_chunks",
      "update_chunks",
    ]) {
      const rows = await storage.exec<{ count: number }>(
        `SELECT count(*) AS count FROM ${table}`,
      );
      assert.equal(rows[0]?.count, 0, `${table} must be purged`);
    }
  }
  async function create() {
    const created = await createProject({
      db,
      ownerId,
      data: { id: crypto.randomUUID(), name: crypto.randomUUID() },
    });
    const node = await db.query.projectNode.findFirst({
      where: { projectId: created.id, kind: "text" },
    });
    assert(node);
    return { projectId: created.id, node };
  }
  async function connect(projectId: string, nodeId: string) {
    const url = `${origin}/api/collaboration/${projectId}/${nodeId}?protocol=2&clientId=123`;
    const response = await mf.dispatchFetch(url, {
      headers: { Upgrade: "websocket", Cookie: cookie, Origin: origin },
    });
    assert.equal(response.status, 101);
    const socket = response.webSocket;
    assert(socket);
    const messages: ServerMessage[] = [];
    const doc = new Y.Doc();
    let closeCode = 0;
    socket.addEventListener("close", (event) => {
      closeCode = event.code;
    });
    socket.addEventListener("message", (event) => {
      const message = decodeServerMessage(event.data);
      messages.push(message);
      if (message.type === "sync" || message.type === "update")
        Y.applyUpdate(doc, message.update);
    });
    socket.accept();
    const send = (message: ClientMessage) =>
      socket.send(encodeClientMessage(message));
    send({ type: "sync", vector: Y.encodeStateVector(doc) });
    await eventually(
      () => messages.some((m) => m.type === "sync"),
      "Initial sync missing",
    );
    return {
      doc,
      socket,
      closeCode: () => closeCode,
      async edit(value: string, save = false) {
        const vector = Y.encodeStateVector(doc);
        doc.getText("source").insert(0, value);
        const update = Y.encodeStateAsUpdate(doc, vector);
        const id = crypto.randomUUID();
        messages.length = 0;
        send({ type: "update", update });
        if (save) send({ type: "save", id });
        await eventually(
          () =>
            messages.some((m) =>
              save ? m.type === "saved" && m.id === id : m.type === "update",
            ),
          "Edit not accepted",
        );
      },
    };
  }

  console.log("Checking clean idle project deletion and real source GC");
  const idle = await create();
  const idleBytes = new TextEncoder().encode("existing clean snapshot");
  const idleKey = `projects/${idle.projectId}/sources/${await hashSource(idleBytes)}`;
  await bucket.put(idleKey, idleBytes);
  await db
    .update(projectNode)
    .set({ objectKey: idleKey, sizeBytes: BigInt(idleBytes.length) })
    .where(eq(projectNode.id, idle.node.id));
  const room = await connect(idle.projectId, idle.node.id);
  await room.edit("clean saved source", true);
  const idleStorage = await storageFor(idle.projectId);
  assert.equal(
    (
      await idleStorage.exec<{ dirty: number }>("SELECT dirty FROM documents")
    )[0]?.dirty,
    0,
  );
  room.socket.close();
  room.doc.destroy();
  await cleanup(`project-only/${idle.projectId}`);
  assert(
    await registered(idle.projectId),
    "A clean room's registration survives project deletion",
  );
  await mf.unsafeEvictDurableObject(
    "collaboration-test",
    "ProjectCollaboration",
    { name: idle.projectId },
  );
  await cleanup("collect");
  await empty(idle.projectId);
  assert.equal(await registered(idle.projectId), false);
  assert.equal(
    (await bucket.list({ prefix: `projects/${idle.projectId}/` })).objects
      .length,
    0,
  );
  assert.equal(
    await db.query.project.findFirst({ where: { id: idle.projectId } }),
    undefined,
  );
  await cleanup("collect");

  console.log("Checking that the trash keeps documents and unsaved edits");
  const trashed = await create();
  const trashedRoom = await connect(trashed.projectId, trashed.node.id);
  await trashedRoom.edit("saved before trash", true);
  await trashedRoom.edit("unsaved ");
  const identity = Y.encodeStateVector(trashedRoom.doc);
  await cleanup(`trash/${trashed.projectId}`);
  await eventually(
    () => trashedRoom.closeCode() === 1008,
    "Trashed project socket stayed open",
  );
  const trashedStorage = await storageFor(trashed.projectId);
  await eventually(
    async () =>
      (
        await trashedStorage.exec<{ dirty: number }>(
          "SELECT dirty FROM documents",
        )
      )[0]?.dirty === 0,
    "Edits accepted before the trash were not saved",
  );
  await cleanup("collect");
  await cleanup(`purge/${trashed.projectId}`);
  assert(
    await registered(trashed.projectId),
    "Collection must keep a trashed project's room",
  );
  const trashedNode = await db.query.projectNode.findFirst({
    where: { id: trashed.node.id },
  });
  assert(trashedNode?.objectKey);
  assert.equal(
    await (await bucket.get(trashedNode.objectKey))?.text(),
    "unsaved saved before trash",
  );
  await cleanup(`restore/${trashed.projectId}`);
  const restoredRoom = await connect(trashed.projectId, trashed.node.id);
  assert.equal(
    restoredRoom.doc.getText("source").toString(),
    "unsaved saved before trash",
  );
  assert.deepEqual(
    Y.decodeStateVector(Y.encodeStateVector(restoredRoom.doc)),
    Y.decodeStateVector(identity),
    "Restored documents keep the CRDT identities comments anchor to",
  );
  await cleanup(`project/${trashed.projectId}`);
  await empty(trashed.projectId);
  await cleanup("collect");
  assert.equal(await registered(trashed.projectId), false);
  assert.equal(
    (await bucket.list({ prefix: `projects/${trashed.projectId}/` })).objects
      .length,
    0,
  );
  trashedRoom.doc.destroy();
  restoredRoom.doc.destroy();

  console.log("Checking deletion between DO cleanup and SQL acknowledgement");
  const racing = await create();
  const racingRoom = await connect(racing.projectId, racing.node.id);
  await racingRoom.edit("racing deletion", true);
  await cleanup(`delete-after-purge/${racing.projectId}`);
  assert(
    await registered(racing.projectId),
    "Concurrent deletion lost retry registration",
  );
  await cleanup("collect");
  await empty(racing.projectId);
  await eventually(
    () => racingRoom.closeCode() === 1008,
    "Concurrent deletion socket stayed open",
  );
  assert.equal(await registered(racing.projectId), false);
  racingRoom.doc.destroy();

  console.log(
    "Checking recursive file deletion, chunks, dirty edits, and cached documents",
  );
  const files = await create();
  const folderId = crypto.randomUUID();
  const deletedId = crypto.randomUUID();
  await db.insert(projectNode).values({
    id: folderId,
    projectId: files.projectId,
    parentId: files.node.parentId,
    name: "nested",
    kind: "folder",
    sizeBytes: 0n,
  });
  const sourceBytes = new TextEncoder().encode("L".repeat(2 * 1024 * 1024));
  const key = `projects/${files.projectId}/sources/${await hashSource(sourceBytes)}`;
  await bucket.put(key, sourceBytes);
  await db.insert(projectNode).values({
    id: deletedId,
    projectId: files.projectId,
    parentId: folderId,
    name: "large.tex",
    kind: "text",
    objectKey: key,
    sizeBytes: BigInt(sourceBytes.length),
  });
  const kept = await connect(files.projectId, files.node.id);
  await kept.edit("keep this", true);
  const deleted = await connect(files.projectId, deletedId);
  await deleted.edit("accepted dirty ");
  const fileStorage = await storageFor(files.projectId);
  assert.equal(
    (
      await fileStorage.exec<{ dirty: number }>(
        "SELECT dirty FROM documents WHERE node_id = ?",
        deletedId,
      )
    )[0]?.dirty,
    1,
  );
  assert(
    (
      await fileStorage.exec<{ count: number }>(
        "SELECT count(*) AS count FROM snapshot_chunks",
      )
    )[0]?.count,
  );
  // Seed a chunk from an interrupted journal write to cover every retained table.
  await fileStorage.exec(
    "INSERT INTO update_chunks (update_id, part, data) SELECT id, 1, x'01' FROM updates WHERE node_id = ?",
    deletedId,
  );
  await cleanup(`node/${files.projectId}/${folderId}`);
  await eventually(
    () => deleted.closeCode() === 1008,
    "Deleted file socket stayed open",
  );
  for (const table of ["snapshot_chunks", "updates"])
    assert.equal(
      (
        await fileStorage.exec<{ count: number }>(
          `SELECT count(*) AS count FROM ${table} WHERE node_id = ?`,
          deletedId,
        )
      )[0]?.count,
      0,
    );
  assert.equal(
    (
      await fileStorage.exec<{ count: number }>(
        "SELECT count(*) AS count FROM update_chunks",
      )
    )[0]?.count,
    0,
  );
  assert.equal(
    (
      await fileStorage.exec<{ count: number }>(
        "SELECT count(*) AS count FROM documents WHERE node_id = ?",
        deletedId,
      )
    )[0]?.count,
    0,
  );
  assert.equal(kept.closeCode(), 0);
  assert(
    (await db.query.projectNode.findFirst({ where: { id: deletedId } }))
      ?.deletedAt,
  );
  await cleanup("collect");
  assert.equal(await bucket.get(key), null);
  const keptNode = await db.query.projectNode.findFirst({
    where: { id: files.node.id },
  });
  assert(keptNode?.objectKey);
  assert.equal(
    await (await bucket.get(keptNode.objectKey))?.text(),
    "keep this",
  );
  // Reusing a removed identity must load new source, never a surviving memory cache.
  await db.delete(projectNode).where(eq(projectNode.id, deletedId));
  await db.insert(projectNode).values({
    id: deletedId,
    projectId: files.projectId,
    parentId: files.node.parentId,
    name: "replacement.tex",
    kind: "text",
    sizeBytes: 0n,
  });
  const replacement = await connect(files.projectId, deletedId);
  assert.equal(replacement.doc.getText("source").toString(), "");
  await cleanup(`project/${files.projectId}`);
  await eventually(
    () => kept.closeCode() === 1008 && replacement.closeCode() === 1008,
    "Project sockets stayed open",
  );
  await empty(files.projectId);
  await cleanup("collect");
  for (const client of [kept, deleted, replacement]) client.doc.destroy();

  console.log(
    "Checking retry after actual DO SQLite and Postgres cleanup failures",
  );
  const retry = await create();
  const retryRoom = await connect(retry.projectId, retry.node.id);
  await retryRoom.edit("r".repeat(2 * 1024 * 1024), true);
  await retryRoom.edit("dirty retry ");
  const retryStorage = await storageFor(retry.projectId);
  await retryStorage.exec(
    "CREATE TRIGGER fail_cleanup BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT, 'Injected DO cleanup failure'); END",
  );
  try {
    await cleanup(`project/${retry.projectId}`);
    await cleanup("collect", 500);
    await eventually(
      () => retryRoom.closeCode() === 1008,
      "Cleanup failure kept a deleted project's idle socket open",
    );
    assert(await registered(retry.projectId));
    assert.equal(
      (
        await retryStorage.exec<{ count: number }>(
          "SELECT count(*) AS count FROM documents",
        )
      )[0]?.count,
      1,
    );
    assert(
      (
        await retryStorage.exec<{ count: number }>(
          "SELECT count(*) AS count FROM snapshot_chunks",
        )
      )[0]?.count,
      "Failed cleanup must roll back chunk deletion",
    );
    assert(
      (
        await retryStorage.exec<{ count: number }>(
          "SELECT count(*) AS count FROM updates",
        )
      )[0]?.count,
      "Failed cleanup must roll back journal deletion",
    );
    assert.equal(
      (await bucket.list({ prefix: `projects/${retry.projectId}/` })).objects
        .length,
      0,
    );
  } finally {
    await retryStorage.exec("DROP TRIGGER fail_cleanup");
  }
  await db.$client.query(
    "CREATE FUNCTION fail_collaboration_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected SQL cleanup failure'; END $$",
  );
  await db.$client.query(
    "CREATE TRIGGER fail_collaboration_ack BEFORE DELETE ON project_collaboration FOR EACH ROW EXECUTE FUNCTION fail_collaboration_ack()",
  );
  try {
    await cleanup("collect", 500);
    await empty(retry.projectId);
    assert(
      await registered(retry.projectId),
      "Failed SQL acknowledgement lost retry registration",
    );
  } finally {
    await db.$client.query(
      "DROP TRIGGER fail_collaboration_ack ON project_collaboration",
    );
    await db.$client.query("DROP FUNCTION fail_collaboration_ack()");
  }
  await cleanup("collect");
  assert.equal(await registered(retry.projectId), false);
  await cleanup(`purge/${retry.projectId}`);
  await empty(retry.projectId);
  retryRoom.doc.destroy();

  for (const ownership of ["account", "organization"] as const) {
    console.log(
      `Checking ${ownership} cascade with accepted edits and no saved R2 source`,
    );
    const cascade = await create();
    const owningId = crypto.randomUUID();
    if (ownership === "account") {
      await db.insert(user).values({
        id: owningId,
        name: owningId,
        email: `${owningId}@example.com`,
        createdAt: new Date(),
      });
      await db
        .update(project)
        .set({ ownerId: owningId })
        .where(eq(project.id, cascade.projectId));
      await db.insert(projectCollaborator).values({
        projectId: cascade.projectId,
        userId: ownerId,
        role: "editor",
      });
    } else {
      await db.insert(organization).values({
        id: owningId,
        name: owningId,
        slug: owningId,
        createdAt: new Date(),
      });
      await db.insert(member).values({
        id: crypto.randomUUID(),
        organizationId: owningId,
        userId: ownerId,
        role: "owner",
        createdAt: new Date(),
      });
      await db
        .update(project)
        .set({ ownerId: null, organizationId: owningId })
        .where(eq(project.id, cascade.projectId));
    }
    const client = await connect(cascade.projectId, cascade.node.id);
    await client.edit("accepted before cascade");
    assert.equal(
      (await bucket.list({ prefix: `projects/${cascade.projectId}/` })).objects
        .length,
      0,
    );
    if (ownership === "account")
      await db.delete(user).where(eq(user.id, owningId));
    else await db.delete(organization).where(eq(organization.id, owningId));
    assert.equal(
      await db.query.project.findFirst({ where: { id: cascade.projectId } }),
      undefined,
    );
    assert.equal(
      await db.query.projectNode.findFirst({ where: { id: cascade.node.id } }),
      undefined,
    );
    assert(await registered(cascade.projectId));
    await cleanup("collect");
    await eventually(
      () => client.closeCode() === 1008,
      "Cascade socket stayed open",
    );
    await empty(cascade.projectId);
    assert.equal(await registered(cascade.projectId), false);
    assert.equal(
      (await bucket.list({ prefix: `projects/${cascade.projectId}/` })).objects
        .length,
      0,
    );
    await mf.unsafeEvictDurableObject(
      "collaboration-test",
      "ProjectCollaboration",
      { name: cascade.projectId },
    );
    await cleanup(`purge/${cascade.projectId}`);
    await empty(cascade.projectId);
    client.doc.destroy();
  }

  console.log("Checking retention alarm for a clean disconnected room");
  const retention = await create();
  const retentionRoom = await connect(retention.projectId, retention.node.id);
  await retentionRoom.edit("alarm cleanup", true);
  retentionRoom.socket.close();
  await db.delete(project).where(eq(project.id, retention.projectId));
  const retentionStorage = await storageFor(retention.projectId);
  await eventually(
    async () =>
      (
        await retentionStorage.exec<{ count: number }>(
          "SELECT count(*) AS count FROM documents",
        )
      )[0]?.count === 0,
    "Clean room retention alarm did not purge storage",
  );
  await empty(retention.projectId);
  retentionRoom.doc.destroy();
  await cleanup("collect");
}
