import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import { project, projectCollaborator, projectNode } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import type { Miniflare } from "miniflare";
import * as Y from "yjs";
import { z } from "zod";

import {
  awarenessFrame,
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../src/lib/collaboration/protocol";

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

async function bounded<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 12_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const createdLink = z.object({ id: z.uuid(), token: z.string() });

// Anonymous share-link viewers: read-only, no presence, and revocable live.
export async function checkShareLinks({
  mf,
  db,
  origin,
  ownerId,
  editorId,
  cookies,
}: {
  mf: Miniflare;
  db: Db;
  origin: string;
  ownerId: string;
  editorId: string;
  cookies: Map<string, string>;
}) {
  console.log("Checking share-link collaboration access");
  const projectId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  const sockets: NonNullable<
    Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]
  >[] = [];
  const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const socketUrl = `${origin}/api/collaboration/${projectId}/${nodeId}`;
  try {
    await db
      .insert(project)
      .values({ id: projectId, name: projectId, ownerId });
    await db.insert(projectNode).values({
      id: nodeId,
      projectId,
      name: "main.tex",
      kind: "text",
      sizeBytes: 0n,
    });
    await db
      .insert(projectCollaborator)
      .values({ projectId, userId: editorId, role: "editor" });

    async function access(action: string, body: Record<string, string>) {
      const response = await mf.dispatchFetch(
        `${origin}/access/${action}/${projectId}`,
        {
          method: "POST",
          headers: { "X-Owner": ownerId },
          body: JSON.stringify(body),
        },
      );
      assert(response.ok, `Share ${action} failed`);
      return response;
    }
    const link = createdLink.parse(
      await (await access("share-create", { scope: "project" })).json(),
    );
    const pdfLink = createdLink.parse(
      await (await access("share-create", { scope: "pdf" })).json(),
    );

    async function connect(
      clientId: number,
      auth: { userId: string } | { token: string },
    ) {
      const url =
        "token" in auth
          ? `${socketUrl}?protocol=2&clientId=${clientId}&share=${auth.token}`
          : `${socketUrl}?protocol=2&clientId=${clientId}`;
      const response = await mf.dispatchFetch(url, {
        headers: {
          Origin: origin,
          Upgrade: "websocket",
          ...("userId" in auth
            ? { Cookie: cookies.get(auth.userId) ?? "" }
            : {}),
        },
      });
      assert.equal(response.status, 101, "Socket did not upgrade");
      const socket = response.webSocket;
      assert(socket);
      sockets.push(socket);
      socket.accept();
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
      const send = (message: ClientMessage) =>
        socket.send(encodeClientMessage(message));
      send({ type: "sync", vector: Y.encodeStateVector(doc) });
      await eventually(
        () => messages.some((m) => m.type === "sync"),
        "Socket did not synchronize",
      );
      return { messages, doc, send, closeCode: () => closeCode };
    }
    const awareness = (messages: ServerMessage[]) =>
      messages.filter((m) => m.type === "awareness").length;

    const owner = await connect(1, { userId: ownerId });
    const editor = await connect(2, { userId: editorId });
    const guest = await connect(3, { token: link.token });
    const sync = guest.messages.find((m) => m.type === "sync");
    assert(sync?.type === "sync");
    assert.equal(sync.canWrite, false, "Share links are read-only");
    assert.equal(sync.user.name, "Guest");

    // Guests receive live edits.
    owner.doc.getText("source").insert(0, "shared text");
    owner.send({
      type: "update",
      update: Y.encodeStateAsUpdate(owner.doc),
    });
    await eventually(
      () => guest.doc.getText("source").toString() === "shared text",
      "Guest missed a live edit",
    );

    // Guests cannot write.
    const denied = new Y.Doc();
    denied.getText("source").insert(0, "DENIED");
    guest.send({
      type: "update",
      update: Y.encodeStateAsUpdate(denied),
    });
    denied.destroy();
    await eventually(
      () =>
        guest.messages.some(
          (m) => m.type === "error" && /Viewers cannot edit/.test(m.message),
        ),
      "Guest could write",
    );

    // Guests neither publish nor see presence. The guest's frame is sent
    // first; the editor's frame arriving later shows the room processed both.
    const ownerAwareness = awareness(owner.messages);
    guest.send({
      type: "awareness",
      update: awarenessFrame(3, 1, { cursor: null }),
    });
    editor.send({
      type: "awareness",
      update: awarenessFrame(2, 1, { cursor: null }),
    });
    await eventually(
      () => awareness(owner.messages) > ownerAwareness,
      "Owner missed editor presence",
    );
    assert.equal(
      awareness(owner.messages),
      ownerAwareness + 1,
      "Guest presence reached collaborators",
    );
    assert.equal(awareness(guest.messages), 0, "Guest saw collaborators");
    assert.equal(
      owner.doc.getText("source").toString(),
      "shared text",
      "Guest edit reached the room",
    );

    // PDF-only links never open sources.
    assert.equal(
      (
        await mf.dispatchFetch(
          `${socketUrl}?protocol=2&clientId=4&share=${pdfLink.token}`,
          { headers: { Origin: origin, Upgrade: "websocket" } },
        )
      ).status,
      404,
      "PDF-only link opened a source",
    );

    // Both link kinds follow the live build stream.
    for (const token of [link.token, pdfLink.token]) {
      const response = await fetch(
        `${origin}/api/compile/${projectId}?events=1&share=${token}`,
      );
      assert.equal(response.status, 200);
      assert(response.body);
      const reader = response.body.getReader();
      streams.push(reader);
      assert.match(
        new TextDecoder().decode(
          (await bounded(reader.read(), "Initial stream timed out")).value,
        ),
        /attached/,
      );
    }
    const [guestEvents, pdfEvents] = streams;
    assert(guestEvents && pdfEvents);

    // Revocation closes the guest's socket and stream; other links keep working.
    const before = guest.messages.length;
    await access("share-revoke", { linkId: link.id });
    const secret = `secret-${crypto.randomUUID()}`;
    owner.doc.getText("source").insert(0, secret);
    owner.send({
      type: "update",
      update: Y.encodeStateAsUpdate(owner.doc, Y.encodeStateVector(editor.doc)),
    });
    await eventually(
      () => editor.doc.getText("source").toString().includes(secret),
      "Editor missed an edit after revocation",
    );
    await eventually(
      () => guest.closeCode() !== 0 || guest.messages.length > before,
      "Revoked guest socket stayed open",
    );
    assert.equal(guest.messages.length, before, "Revoked guest got data");
    assert.equal(guest.closeCode(), 1008);
    const guestEnd = guestEvents.read();
    await fetch(`${origin}/fixture/emit/${projectId}`, {
      method: "POST",
      body: `data: ${secret}\n\n`,
    });
    assert.equal(
      (await bounded(guestEnd, "Revoked guest stream stayed open")).done,
      true,
      "Revoked guest stream leaked a payload",
    );
    assert.match(
      new TextDecoder().decode(
        (await bounded(pdfEvents.read(), "PDF link lost build updates")).value,
      ),
      new RegExp(secret),
    );
    assert.equal(
      (
        await mf.dispatchFetch(
          `${socketUrl}?protocol=2&clientId=3&share=${link.token}`,
          {
            headers: { Origin: origin, Upgrade: "websocket" },
          },
        )
      ).status,
      401,
      "Revoked link reconnected",
    );
    for (const client of [owner, editor, guest]) client.doc.destroy();
  } finally {
    await Promise.all(streams.map((reader) => reader.cancel().catch(() => {})));
    for (const socket of sockets) if (socket?.readyState === 1) socket.close();
    await db.delete(project).where(eq(project.id, projectId));
  }
}
