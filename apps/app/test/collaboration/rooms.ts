import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import { project, projectCollaborator, projectNode } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import type { Miniflare } from "miniflare";
import * as Y from "yjs";
import { z } from "zod";

import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "#/lib/collaboration";

import { createProject } from "../../src/lib/projects/project.server";

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

// What one document's work may and may not hold up, and what a room keeps alive.
export async function checkRooms({
  mf,
  db,
  origin,
  ownerId,
  editorId,
  viewerId,
  cookies,
}: {
  mf: Miniflare;
  db: Db;
  origin: string;
  ownerId: string;
  editorId: string;
  viewerId: string;
  cookies: Map<string, string>;
}) {
  const bucket = await mf.getR2Bucket("SOURCES");
  const { id: projectId } = await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: crypto.randomUUID() },
  });
  const main = await db.query.projectNode.findFirst({
    where: { projectId, kind: "text" },
  });
  assert(main);
  const otherId = crypto.randomUUID();
  await db.insert(projectNode).values({
    id: otherId,
    projectId,
    parentId: main.parentId,
    name: "other.tex",
    kind: "text",
    sizeBytes: 0n,
  });
  await db.insert(projectCollaborator).values([
    { projectId, userId: editorId, role: "editor" },
    { projectId, userId: viewerId, role: "viewer" },
  ]);
  const clients: {
    socket: { readyState: number; close: () => void };
    doc: Y.Doc;
  }[] = [];
  async function connect(userId: string, nodeId: string) {
    const response = await mf.dispatchFetch(
      `${origin}/api/collaboration/${projectId}/${nodeId}?protocol=2&clientId=123`,
      {
        headers: {
          Upgrade: "websocket",
          Cookie: cookies.get(userId) ?? "",
          Origin: origin,
        },
      },
    );
    assert.equal(response.status, 101);
    const socket = response.webSocket;
    assert(socket);
    const doc = new Y.Doc();
    const messages: ServerMessage[] = [];
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
      () => messages.some((message) => message.type === "sync"),
      "Initial sync missing",
    );
    const client = {
      socket,
      doc,
      messages,
      send,
      closeCode: () => closeCode,
      type(value: string) {
        const vector = Y.encodeStateVector(doc);
        doc.getText("source").insert(0, value);
        send({
          type: "update",
          update: Y.encodeStateAsUpdate(doc, vector),
        });
      },
      text: () => doc.getText("source").toString(),
    };
    clients.push(client);
    return client;
  }
  async function usage() {
    const response = await mf.dispatchFetch(`${origin}/usage/${projectId}`);
    return z
      .object({
        databaseUses: z.number(),
        alarms: z.number(),
        documents: z.array(z.string()),
      })
      .parse(await response.json());
  }
  async function stored(nodeId: string) {
    const node = await db.query.projectNode.findFirst({
      where: { id: nodeId },
    });
    return node?.objectKey
      ? await (await bucket.get(node.objectKey))?.text()
      : "";
  }

  try {
    console.log("Checking that edits do not wait for a save in progress");
    const owner = await connect(ownerId, main.id);
    const editor = await connect(editorId, main.id);
    const elsewhere = await connect(editorId, otherId);
    owner.type("saved ");
    await eventually(() => editor.text() === "saved ", "Edit missing");
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // A save needs this lock to commit.
    const holding = db.transaction(async (tx) => {
      await tx
        .select({ id: project.id })
        .from(project)
        .where(eq(project.id, projectId))
        .for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const saveId = crypto.randomUUID();
    try {
      owner.send({ type: "save", id: saveId });
      // Let the save start, and reach the lock.
      await new Promise((resolve) => setTimeout(resolve, 300));
      owner.type("during ");
      await eventually(
        () => editor.text() === "during saved ",
        "A save held up its own document",
      );
      elsewhere.type("elsewhere");
      await eventually(
        () => elsewhere.messages.some((message) => message.type === "update"),
        "A save held up another document",
      );
      assert(!owner.messages.some((message) => message.type === "saved"));
    } finally {
      release.resolve();
      await holding;
    }
    await eventually(
      () =>
        owner.messages.some(
          (message) => message.type === "saved" && message.id === saveId,
        ),
      "The save never finished",
    );
    const saved = owner.messages.find((message) => message.type === "saved");
    assert.equal(
      saved?.value,
      "saved ",
      "A save acknowledges exactly what it stored",
    );
    // The edit that arrived meanwhile keeps the document dirty until it is saved.
    await eventually(
      async () => (await stored(main.id)) === "during saved ",
      "The later edit was not saved",
    );
    await eventually(
      async () => (await stored(otherId)) === "elsewhere",
      "The other document was not saved",
    );

    console.log("Checking a save whose acknowledgement was lost");
    const storage = await mf.unsafeGetDurableObjectStorage(
      "collaboration-test",
      "ProjectCollaboration",
      { name: projectId },
    );
    const [row] = await storage.exec<{ object_key: string }>(
      "SELECT object_key FROM documents WHERE node_id = ?",
      main.id,
    );
    assert(row);
    // As left by a crash after Postgres committed and more edits arrived.
    owner.type("later ");
    await eventually(
      () => editor.text() === "later during saved ",
      "Edit missing",
    );
    await storage.exec(
      "INSERT INTO saves VALUES (?, ?)",
      main.id,
      row.object_key,
    );
    await storage.exec(
      "UPDATE documents SET object_key = 'lost', dirty = 1 WHERE node_id = ?",
      main.id,
    );
    await mf.unsafeEvictDurableObject(
      "collaboration-test",
      "ProjectCollaboration",
      { name: projectId, webSockets: "hibernate" },
    );
    owner.type("recovered ");
    await eventually(
      async () => (await stored(main.id)) === "recovered later during saved ",
      "Edits after an unacknowledged save were not saved",
    );
    assert(
      !owner.messages.some((message) => message.type === "error"),
      "An unacknowledged save looked like a foreign change",
    );

    console.log("Checking that one check covers everyone connected");
    const viewer = await connect(viewerId, main.id);
    await eventually(
      async () =>
        (await storage.exec("SELECT node_id FROM documents WHERE dirty <> 0"))
          .length === 0,
      "Documents stayed dirty",
    );
    await eventually(
      async () =>
        (await storage.exec("SELECT duty FROM alarms WHERE duty = 'save'"))
          .length === 0,
      "The save alarm stayed planned",
    );
    const before = await usage();
    await mf.dispatchFetch(`${origin}/backstop/${projectId}`);
    await eventually(
      async () => (await usage()).alarms > before.alarms,
      "The check never ran",
    );
    await eventually(
      async () => (await usage()).databaseUses - before.databaseUses >= 2,
      "The check did not reach Postgres",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      (await usage()).databaseUses - before.databaseUses,
      2,
      "The check connects once for access and once for files",
    );
    assert.equal(viewer.closeCode(), 0);
    const [planned] = await storage.exec<{ at: number }>(
      "SELECT at FROM alarms WHERE duty = 'access'",
    );
    assert(planned && planned.at > Date.now() + 40_000, "The check is rare");

    console.log("Checking that unused documents leave memory");
    // Hibernation dropped both, and only one has been used since.
    assert.deepEqual((await usage()).documents, [main.id]);
    elsewhere.send({
      type: "sync",
      vector: Y.encodeStateVector(elsewhere.doc),
    });
    await eventually(
      async () => (await usage()).documents.includes(otherId),
      "A document in use did not load",
    );
    elsewhere.socket.close();
    await eventually(
      async () => !(await usage()).documents.includes(otherId),
      "A document nobody has open stayed in memory",
    );
    const reopened = await connect(editorId, otherId);
    assert.equal(reopened.text(), "elsewhere");
    reopened.type("still ");
    await eventually(
      async () => (await stored(otherId)) === "still elsewhere",
      "A reloaded document was not saved",
    );
  } finally {
    for (const { socket, doc } of clients) {
      if (socket.readyState === 1) socket.close();
      doc.destroy();
    }
    await db.delete(project).where(eq(project.id, projectId));
  }
}
