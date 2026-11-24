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
  scratchpadId,
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

// The scratchpad: shared notes kept in the room rather than the source tree,
// for people with their own access to the project.
export async function checkScratchpad({
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
  console.log("Checking the scratchpad");
  const bucket = await mf.getR2Bucket("SOURCES");
  const sockets: { readyState: number; close(): void }[] = [];
  const projectIds: string[] = [];
  async function newProject() {
    const { id } = await createProject({
      db,
      ownerId,
      data: { id: crypto.randomUUID(), name: crypto.randomUUID() },
    });
    projectIds.push(id);
    return id;
  }
  const storageFor = (projectId: string) =>
    mf.unsafeGetDurableObjectStorage(
      "collaboration-test",
      "ProjectCollaboration",
      { name: projectId },
    );
  async function storedDocuments(projectId: string) {
    const storage = await storageFor(projectId);
    return storage.exec<{ node_id: string; dirty: number }>(
      "SELECT node_id, dirty FROM documents",
    );
  }
  async function post(
    path: string,
    body: Record<string, string> = {},
    status?: number,
  ) {
    const response = await mf.dispatchFetch(`${origin}${path}`, {
      method: "POST",
      headers: { "X-Owner": ownerId },
      body: JSON.stringify(body),
    });
    if (status) assert.equal(response.status, status, path);
    else assert(response.ok, path);
    return response;
  }
  // What the assistant's read_scratchpad tool calls.
  const read = (projectId: string, userId: string) =>
    post(`/scratchpad/${projectId}`, { userId });
  const denied = (projectId: string, userId: string) =>
    post(`/scratchpad/${projectId}`, { userId }, 404);
  function request(
    projectId: string,
    auth: { userId: string } | { token: string },
  ) {
    const clientId = Math.floor(Math.random() * 0xffffffff);
    return mf.dispatchFetch(
      `${origin}/api/collaboration/${projectId}/${scratchpadId}?protocol=2&clientId=${clientId}${"token" in auth ? `&share=${auth.token}` : ""}`,
      {
        headers: {
          Origin: origin,
          Upgrade: "websocket",
          ...("userId" in auth
            ? { Cookie: cookies.get(auth.userId) ?? "" }
            : {}),
        },
      },
    );
  }
  async function connect(projectId: string, userId: string) {
    const response = await request(projectId, { userId });
    assert.equal(response.status, 101, "Scratchpad did not open");
    const socket = response.webSocket;
    assert(socket);
    sockets.push(socket);
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
      () => messages.some((message) => message.type === "sync"),
      "Scratchpad did not synchronize",
    );
    const text = doc.getText("source");
    return {
      messages,
      text: () => text.toString(),
      send,
      edit(value: string) {
        const before = Y.encodeStateVector(doc);
        text.insert(text.length, value);
        send({ type: "update", update: Y.encodeStateAsUpdate(doc, before) });
      },
      async save() {
        const id = crypto.randomUUID();
        send({ type: "save", id });
        let saved: ServerMessage | undefined;
        await eventually(() => {
          saved = messages.find(
            (message) => message.type === "saved" && message.id === id,
          );
          return !!saved;
        }, "Scratchpad was not saved");
        assert(saved?.type === "saved");
        return saved;
      },
      close: () => socket.close(),
      closeCode: () => closeCode,
    };
  }
  try {
    const projectId = await newProject();
    await db.insert(projectCollaborator).values([
      { projectId, userId: editorId, role: "editor" },
      { projectId, userId: viewerId, role: "viewer" },
    ]);
    const nodesBefore = await db.query.projectNode.findMany({
      where: { projectId },
    });

    // Reading a scratchpad nobody has opened does not create it.
    assert.equal(await (await read(projectId, viewerId)).text(), "");
    assert.deepEqual(await storedDocuments(projectId), []);

    const owner = await connect(projectId, ownerId);
    const editor = await connect(projectId, editorId);
    const viewer = await connect(projectId, viewerId);
    owner.edit("# Notes\n");
    await eventually(
      () => editor.text() === "# Notes\n" && viewer.text() === "# Notes\n",
      "Scratchpad edit did not reach collaborators",
    );
    editor.edit("- [ ] todo\n");
    const text = "# Notes\n- [ ] todo\n";
    await eventually(
      () => owner.text() === text && viewer.text() === text,
      "Editor's scratchpad edit did not reach collaborators",
    );

    // Viewers read but cannot edit.
    const sync = viewer.messages.find((message) => message.type === "sync");
    assert(sync?.type === "sync");
    assert.equal(sync.canWrite, false);
    const rejected = new Y.Doc();
    rejected.getText("source").insert(0, "DENIED");
    viewer.send({ type: "update", update: Y.encodeStateAsUpdate(rejected) });
    rejected.destroy();
    await eventually(
      () =>
        viewer.messages.some(
          (message) =>
            message.type === "error" &&
            /Viewers cannot edit/.test(message.message),
        ),
      "Viewer could edit the scratchpad",
    );

    // Saves confirm edits the room already stores, without a source object.
    const saved = await owner.save();
    assert.equal(saved.value, text);
    assert.equal(saved.objectKey, null);
    for (const userId of [ownerId, editorId, viewerId])
      assert.equal(await (await read(projectId, userId)).text(), text);

    // Anyone else is refused, however they ask.
    const stranger = crypto.randomUUID();
    await denied(projectId, stranger);
    for (const scope of ["project", "pdf"]) {
      const link = z
        .object({ id: z.uuid(), token: z.string() })
        .parse(
          await (
            await post(`/access/share-create/${projectId}`, { scope })
          ).json(),
        );
      const asGuest = await request(projectId, { token: link.token });
      assert.equal(asGuest.status, 404, `${scope} link opened the scratchpad`);
      await denied(projectId, `share:${link.id}`);
    }
    assert.equal(
      (
        await mf.dispatchFetch(
          `${origin}/api/collaboration/${projectId}/${scratchpadId}?protocol=2&clientId=1`,
          { headers: { Origin: origin, Upgrade: "websocket" } },
        )
      ).status,
      401,
    );

    // It stays out of the source tree, through the room's alarm and purge.
    await post(`/cleanup/purge/${projectId}`);
    const storage = await storageFor(projectId);
    assert.deepEqual(
      await storage.exec("SELECT node_id, dirty, object_key FROM documents"),
      [{ node_id: scratchpadId, dirty: 0, object_key: null }],
    );
    const nodesAfter = await db.query.projectNode.findMany({
      where: { projectId },
    });
    assert.deepEqual(
      nodesAfter.map(({ id, objectKey }) => ({ id, objectKey })),
      nodesBefore.map(({ id, objectKey }) => ({ id, objectKey })),
    );
    const { objects } = await bucket.list({ prefix: `projects/${projectId}/` });
    assert.deepEqual(objects, [], "Scratchpad wrote a source object");

    // Compaction keeps it whole.
    for (let index = 0; index < 70; index++) owner.edit("x");
    const full = text + "x".repeat(70);
    await owner.save();
    const [journal] = await storage.exec<{ count: number }>(
      "SELECT count(*) AS count FROM updates",
    );
    assert((journal?.count ?? 1000) < 64);

    // It survives everyone leaving and the room being evicted.
    for (const client of [owner, editor, viewer]) client.close();
    await mf.unsafeEvictDurableObject(
      "collaboration-test",
      "ProjectCollaboration",
      { name: projectId, webSockets: "hibernate" },
    );
    const returned = await connect(projectId, viewerId);
    assert.equal(returned.text(), full);

    // Revoking access closes it.
    await post(`/access/revoke/${projectId}`, { userId: viewerId });
    await eventually(
      () => returned.closeCode() === 1008,
      "Revoked viewer kept the scratchpad open",
    );
    await denied(projectId, viewerId);

    // Trash keeps it, and permanent deletion removes it.
    await post(`/cleanup/trash/${projectId}`);
    await denied(projectId, ownerId);
    await post(`/cleanup/purge/${projectId}`);
    assert.equal((await storedDocuments(projectId)).length, 1);
    await post(`/cleanup/restore/${projectId}`);
    assert.equal(await (await read(projectId, ownerId)).text(), full);
    await post(`/cleanup/project/${projectId}`);
    for (const table of ["documents", "updates", "snapshot_chunks"])
      assert.deepEqual(
        await (
          await storageFor(projectId)
        ).exec(`SELECT 1 FROM ${table} LIMIT 1`),
        [],
        `${table} kept a deleted project's scratchpad`,
      );

    // A file may have the same name; only the reserved ID is the scratchpad.
    const other = await newProject();
    const [root] = await db.query.projectNode.findMany({
      where: { projectId: other, parentId: { isNull: true } },
    });
    assert(root);
    await db.insert(projectNode).values({
      projectId: other,
      parentId: root.id,
      name: scratchpadId,
      kind: "text",
      sizeBytes: 0n,
    });
    const otherOwner = await connect(other, ownerId);
    assert.equal(otherOwner.text(), "", "Projects do not share a scratchpad");
  } finally {
    for (const socket of sockets) if (socket.readyState === 1) socket.close();
    for (const id of projectIds)
      await db.delete(project).where(eq(project.id, id));
  }
}
