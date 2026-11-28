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
} from "#/lib/collaboration";
import { shareCookieName } from "#/lib/sharing/share-token";

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

const createdLink = z.object({ id: z.uuid(), token: z.string() });

// Share links. Anonymous guests present a view link's token in the share
// cookie: read-only, no presence, and revocable live. Comment and edit links
// do nothing without an account; redeemed by one, they grant its role until
// the link is revoked.
export async function checkShareLinks({
  mf,
  db,
  origin,
  ownerId,
  editorId,
  linkedId,
  cookies,
}: {
  mf: Miniflare;
  db: Db;
  origin: string;
  ownerId: string;
  editorId: string;
  // Has no access until it redeems an edit link.
  linkedId: string;
  cookies: Map<string, string>;
}) {
  console.log("Checking share-link collaboration access");
  const projectId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  const sockets: NonNullable<
    Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]
  >[] = [];
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
    const create = async (role: string) =>
      createdLink.parse(await (await access("share-create", { role })).json());
    const link = await create("viewer");
    const otherLink = await create("viewer");
    const commentLink = await create("commenter");
    const editLink = await create("editor");
    const shareCookie = (token: string) =>
      `${shareCookieName(projectId)}=${token}`;

    async function connect(
      clientId: number,
      auth: { userId: string } | { token: string },
    ) {
      const url = `${socketUrl}?protocol=2&clientId=${clientId}`;
      const response = await mf.dispatchFetch(url, {
        headers: {
          Origin: origin,
          Upgrade: "websocket",
          Cookie:
            "userId" in auth
              ? (cookies.get(auth.userId) ?? "")
              : shareCookie(auth.token),
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

    // Without an account, comment and edit links open nothing, and a token in
    // the URL is not a credential.
    for (const [headers, label] of [
      [{ Cookie: shareCookie(commentLink.token) }, "comment link"],
      [{ Cookie: shareCookie(editLink.token) }, "edit link"],
      [{}, "token in the URL"],
    ] as const)
      assert.equal(
        (
          await mf.dispatchFetch(
            `${socketUrl}?protocol=2&clientId=4&share=${link.token}`,
            { headers: { Origin: origin, Upgrade: "websocket", ...headers } },
          )
        ).status,
        401,
        `Anonymous ${label} opened a source`,
      );

    // An account that redeems an edit link edits through it.
    await access("share-redeem", { token: editLink.token, userId: linkedId });
    const linked = await connect(5, { userId: linkedId });
    const linkedSync = linked.messages.find((m) => m.type === "sync");
    assert(linkedSync?.type === "sync");
    assert.equal(linkedSync.canWrite, true, "Edit link did not grant editing");

    // Guests follow the live build stream.
    const [guestEvents, otherEvents] = await Promise.all(
      [link.token, otherLink.token].map(async (token) => {
        const response = await mf.dispatchFetch(
          `${origin}/api/compile/${projectId}?events=1`,
          {
            headers: {
              Origin: origin,
              Upgrade: "websocket",
              Cookie: shareCookie(token),
            },
          },
        );
        assert.equal(response.status, 101);
        const socket = response.webSocket;
        assert(socket);
        sockets.push(socket);
        const frames: string[] = [];
        let closeCode = 0;
        socket.addEventListener("message", (event) => {
          if (event.data !== "pong") frames.push(String(event.data));
        });
        socket.addEventListener("close", (event) => {
          closeCode = event.code;
        });
        socket.accept();
        // As the browser does when the socket opens.
        socket.send("ping");
        await eventually(() => frames.length > 0, "Initial frame timed out");
        return { frames, closeCode: () => closeCode };
      }),
    );
    assert(guestEvents && otherEvents);

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
    await fetch(`${origin}/fixture/emit/${projectId}`, {
      method: "POST",
      body: secret,
    });
    await eventually(
      () => otherEvents.frames.includes(secret),
      "Another link lost build updates",
    );
    await eventually(
      () => guestEvents.closeCode() !== 0,
      "Revoked guest events stayed open",
    );
    assert.equal(guestEvents.closeCode(), 1008);
    assert.equal(guestEvents.frames.length, 1, "Revoked guest got events");
    assert.equal(
      (
        await mf.dispatchFetch(`${socketUrl}?protocol=2&clientId=3`, {
          headers: {
            Origin: origin,
            Upgrade: "websocket",
            Cookie: shareCookie(link.token),
          },
        })
      ).status,
      401,
      "Revoked link reconnected",
    );
    // Revoking the edit link ends the access it gave the account, live.
    await access("share-revoke", { linkId: editLink.id });
    await eventually(
      () => linked.closeCode() !== 0,
      "Revoked link grant kept its socket",
    );
    assert.equal(linked.closeCode(), 1008);
    assert.equal(
      (
        await mf.dispatchFetch(`${socketUrl}?protocol=2&clientId=5`, {
          headers: {
            Origin: origin,
            Upgrade: "websocket",
            Cookie: cookies.get(linkedId) ?? "",
          },
        })
      ).status,
      404,
      "Revoked link grant reconnected",
    );
    for (const client of [owner, editor, guest, linked]) client.doc.destroy();
  } finally {
    for (const socket of sockets) if (socket?.readyState === 1) socket.close();
    await db.delete(project).where(eq(project.id, projectId));
  }
}
