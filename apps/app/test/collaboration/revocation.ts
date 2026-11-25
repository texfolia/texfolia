import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectCollaborator,
  projectJob,
  projectNode,
} from "@texfolia/db/schema";
import { and, eq } from "drizzle-orm";
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

type Client = {
  doc: Y.Doc;
  messages: ServerMessage[];
  send: (message: ClientMessage) => void;
};

export async function checkRevocation({
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
  for (const ownership of ["personal", "organization"] as const) {
    for (const trigger of ["source", "awareness", "idle"] as const) {
      console.log(`Checking ${ownership} revocation on ${trigger}`);
      const projectId = crypto.randomUUID();
      const nodeId = crypto.randomUUID();
      const organizationId = crypto.randomUUID();
      const removedMembershipId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      const sockets: NonNullable<
        Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]
      >[] = [];
      const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
      const headers = (userId: string) => ({
        Cookie: cookies.get(userId) ?? "",
        Origin: origin,
      });
      const socketUrl = `${origin}/api/collaboration/${projectId}/${nodeId}?protocol=2&clientId=123`;
      const eventsUrl = `${origin}/api/compile/${projectId}?events=1`;
      try {
        if (ownership === "organization") {
          await db.insert(organization).values({
            id: organizationId,
            name: "Revocation",
            slug: organizationId,
            createdAt: new Date(),
          });
          await db.insert(member).values(
            [ownerId, editorId, viewerId].map((userId) => ({
              id:
                userId === editorId ? removedMembershipId : crypto.randomUUID(),
              organizationId,
              userId,
              role: userId === editorId ? "admin" : "member",
              createdAt: new Date(),
            })),
          );
        }
        await db.insert(project).values({
          id: projectId,
          name: projectId,
          ...(ownership === "personal" ? { ownerId } : { organizationId }),
        });
        await db.insert(projectNode).values({
          id: nodeId,
          projectId,
          name: "main.tex",
          kind: "text",
          sizeBytes: 0n,
        });
        await db
          .insert(projectJob)
          .values({ id: jobId, projectId, sizeBytes: 0n });
        if (ownership === "personal")
          await db.insert(projectCollaborator).values([
            { projectId, userId: editorId, role: "editor" },
            { projectId, userId: viewerId, role: "viewer" },
          ]);

        async function connect(userId: string) {
          const response = await mf.dispatchFetch(socketUrl, {
            headers: { ...headers(userId), Upgrade: "websocket" },
          });
          assert.equal(response.status, 101);
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
          send({
            type: "sync",
            vector: Y.encodeStateVector(doc),
          });
          await eventually(
            () => messages.some((m) => m.type === "sync"),
            "Socket did not synchronize",
          );
          return { socket, messages, doc, send, closeCode: () => closeCode };
        }
        async function changeAccess(
          action: "grant" | "revoke" | "member-removed",
          body: Record<string, string>,
        ) {
          const response = await mf.dispatchFetch(
            `${origin}/access/${action}/${projectId}`,
            {
              method: "POST",
              headers: { "X-Owner": ownerId },
              body: JSON.stringify(body),
            },
          );
          assert.equal(response.status, 204, `Access ${action} failed`);
        }
        async function usage() {
          const response = await mf.dispatchFetch(
            `${origin}/usage/${projectId}`,
          );
          return z
            .object({ databaseUses: z.number(), alarms: z.number() })
            .parse(await response.json());
        }
        // Edits and cursors from users with unchanged access must not touch Postgres.
        async function checkEditsSkipDatabase(...clients: Client[]) {
          const [author, ...peers] = clients;
          assert(author);
          for (let attempt = 0; ; attempt++) {
            const before = await usage();
            for (let index = 0; index < 10; index++) {
              const vector = Y.encodeStateVector(author.doc);
              author.doc.getText("source").insert(0, "k");
              author.send({
                type: "update",
                update: Y.encodeStateAsUpdate(author.doc, vector),
              });
              author.send({
                type: "awareness",
                update: awarenessFrame(123, attempt * 10 + index + 2, {
                  cursor: null,
                }),
              });
            }
            const expected = author.doc.getText("source").toString();
            await eventually(
              () =>
                peers.every(
                  (peer) => peer.doc.getText("source").toString() === expected,
                ),
              "Peers missed edits",
            );
            const after = await usage();
            // The flush and access alarms query Postgres by design.
            if (after.alarms !== before.alarms && attempt < 3) continue;
            assert.equal(
              after.databaseUses,
              before.databaseUses,
              "Edits queried Postgres",
            );
            return;
          }
        }
        async function openEvents(userId: string) {
          const response = await mf.dispatchFetch(eventsUrl, {
            headers: { ...headers(userId), Upgrade: "websocket" },
          });
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
          assert.match(frames[0] ?? "", /attached/);
          return { frames, closeCode: () => closeCode };
        }
        async function emit(body: string) {
          await fetch(`${origin}/fixture/emit/${projectId}`, {
            method: "POST",
            body,
          });
        }
        async function builds() {
          const response = await fetch(
            `${origin}/fixture/subscribers/${projectId}`,
          );
          return z
            .object({ recipients: z.number(), checks: z.number() })
            .parse(await response.json());
        }
        async function openPdf(userId: string) {
          const response = await fetch(
            `${origin}/api/compile/${projectId}?job=${jobId}&preview=pdf`,
            { headers: headers(userId) },
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
          return reader;
        }
        const owner = await connect(ownerId);
        const recipient = await connect(editorId);
        const viewer = await connect(viewerId);
        // An edit acknowledged by the room before revocation must still reach R2.
        const accepted = `accepted-${crypto.randomUUID()}`;
        recipient.doc.getText("source").insert(0, accepted);
        recipient.send({
          type: "update",
          update: Y.encodeStateAsUpdate(recipient.doc),
        });
        await eventually(
          () => owner.doc.getText("source").toString() === accepted,
          "Accepted edit missing",
        );
        if (ownership === "personal" && trigger === "source")
          await checkEditsSkipDatabase(owner, recipient, viewer);
        const revokedEvents = await openEvents(editorId);
        const allowedEvents = await openEvents(viewerId);
        const revokedPdf = await openPdf(editorId);
        // Chunks and frames for viewers with unchanged access skip Postgres.
        const { checks } = await builds();
        for (let index = 0; index < 20; index++) {
          await emit(`progress-${index}`);
          await bounded(revokedPdf.read(), "PDF chunk missing");
        }
        await eventually(
          () =>
            [revokedEvents, allowedEvents].every(({ frames }) =>
              frames.includes("progress-19"),
            ),
          "Viewers missed progress",
        );
        assert.equal(
          (await builds()).checks,
          checks,
          "Chunks queried Postgres",
        );

        if (ownership === "personal") {
          await changeAccess("grant", {
            email: `${editorId}@example.com`,
            role: "viewer",
          });
          recipient.send({
            type: "sync",
            vector: Y.encodeStateVector(recipient.doc),
          });
          await eventually(
            () =>
              recipient.messages.some((m) => m.type === "sync" && !m.canWrite),
            "Viewer reconnect/sync lost read access",
          );
          const denied = new Y.Doc();
          denied.getText("source").insert(0, "DENIED");
          recipient.send({
            type: "update",
            update: Y.encodeStateAsUpdate(denied),
          });
          denied.destroy();
          await eventually(
            () =>
              recipient.messages.some(
                (m) =>
                  m.type === "error" && /Viewers cannot edit/.test(m.message),
              ),
            "Downgraded editor could write",
          );
        } else {
          await db
            .update(member)
            .set({ role: "member" })
            .where(eq(member.id, removedMembershipId));
        }
        // Role changes preserve live reads for both personal viewers and organization members.
        await emit("role-change");
        await eventually(
          () =>
            [revokedEvents, allowedEvents].every(({ frames }) =>
              frames.includes("role-change"),
            ),
          "Role change lost events",
        );
        assert.match(
          new TextDecoder().decode(
            (await bounded(revokedPdf.read(), "PDF role chunk missing")).value,
          ),
          /role-change/,
        );
        assert.equal(recipient.closeCode(), 0);
        const receivedBefore = recipient.messages.length;
        const framesBefore = revokedEvents.frames.length;

        // Idle revocation skips the notification to exercise the alarm backstop.
        if (ownership === "personal" && trigger !== "idle")
          await changeAccess("revoke", { userId: editorId });
        else if (ownership === "personal")
          await db
            .delete(projectCollaborator)
            .where(
              and(
                eq(projectCollaborator.projectId, projectId),
                eq(projectCollaborator.userId, editorId),
              ),
            );
        else {
          await db.delete(member).where(eq(member.id, removedMembershipId));
          if (trigger !== "idle")
            await changeAccess("member-removed", {
              organizationId,
              userId: editorId,
            });
        }
        // The recipient sends nothing after deletion, including no application pings.
        const secret = `secret-${crypto.randomUUID()}`;
        if (trigger === "source") {
          owner.doc.getText("source").insert(0, secret);
          owner.send({
            type: "update",
            update: Y.encodeStateAsUpdate(owner.doc),
          });
          await eventually(
            () => viewer.doc.getText("source").toString().includes(secret),
            "Authorized viewer lost source updates",
          );
        } else if (trigger === "awareness") {
          const before = viewer.messages.filter(
            (m) => m.type === "awareness",
          ).length;
          owner.send({
            type: "awareness",
            update: awarenessFrame(123, 1, { cursor: null }),
          });
          await eventually(
            () =>
              viewer.messages.filter((m) => m.type === "awareness").length >
              before,
            "Authorized viewer lost awareness",
          );
        } else {
          // Wake the alarm from hibernation rather than relying on an in-memory timer.
          await mf.unsafeEvictDurableObject(
            "collaboration-test",
            "ProjectCollaboration",
            { name: projectId, webSockets: "hibernate" },
          );
          await mf.dispatchFetch(`${origin}/backstop/${projectId}`);
        }
        await eventually(
          () =>
            recipient.closeCode() !== 0 ||
            recipient.messages.length > receivedBefore,
          "Silent revoked socket stayed open",
        );
        assert.equal(
          recipient.messages.length,
          receivedBefore,
          "Revoked socket received source or awareness data",
        );
        assert.equal(recipient.closeCode(), 1008);
        const pdfEnd = revokedPdf.read();
        // A missed notice is caught by the periodic check instead.
        if (trigger === "idle")
          await fetch(`${origin}/fixture/backstop/${projectId}`);
        else await emit(secret);
        await eventually(
          () => revokedEvents.closeCode() !== 0,
          "Revoked events stayed open",
        );
        assert.equal(revokedEvents.closeCode(), 1008);
        assert.equal(
          revokedEvents.frames.length,
          framesBefore,
          "Events leaked a post-removal payload",
        );
        assert.equal(
          (await bounded(pdfEnd, "Revoked PDF stayed open")).done,
          true,
          "PDF leaked a post-removal payload",
        );
        if (trigger !== "idle")
          await eventually(
            () => allowedEvents.frames.includes(secret),
            "Authorized viewer lost build updates",
          );
        // Viewers stay connected while the object hibernates.
        await mf.unsafeEvictDurableObject(
          "collaboration-test",
          "BuildsFixture",
          { name: projectId, webSockets: "hibernate" },
        );
        await emit("woken");
        await eventually(
          () => allowedEvents.frames.includes("woken"),
          "Hibernated viewer lost build updates",
        );
        assert.equal(allowedEvents.closeCode(), 0);
        await eventually(async () => {
          const row = await db.query.projectNode.findFirst({
            where: { id: nodeId },
          });
          if (!row?.objectKey) return false;
          return (
            (
              await (
                await (await mf.getR2Bucket("SOURCES")).get(row.objectKey)
              )?.text()
            )?.includes(accepted) ?? false
          );
        }, "Accepted edit did not survive revocation");
        assert.equal(
          (
            await mf.dispatchFetch(socketUrl, {
              headers: { ...headers(editorId), Upgrade: "websocket" },
            })
          ).status,
          404,
          "Revoked socket reconnected",
        );
        assert.equal(
          (await fetch(eventsUrl, { headers: headers(editorId) })).status,
          404,
          "Revoked events reconnected",
        );
        assert.equal(
          (await fetch(eventsUrl, { headers: headers(viewerId) })).status,
          426,
          "Events answered without a socket",
        );
        assert.equal(
          (
            await mf.dispatchFetch(eventsUrl, {
              headers: {
                ...headers(viewerId),
                Origin: "https://example.com",
                Upgrade: "websocket",
              },
            })
          ).status,
          403,
          "Another site opened build events",
        );
        assert.equal(
          (
            await fetch(
              `${origin}/api/compile/${projectId}?job=${jobId}&preview=pdf`,
              { headers: headers(editorId) },
            )
          ).status,
          404,
        );
        // Existing viewer access is still valid through authenticated reconnects.
        const reconnected = await connect(viewerId);
        assert.equal(
          reconnected.doc.getText("source").toString(),
          owner.doc.getText("source").toString(),
        );
        assert.equal(
          (
            await mf.dispatchFetch(socketUrl, {
              headers: { Origin: origin, Upgrade: "websocket" },
            })
          ).status,
          401,
        );
        assert.equal((await fetch(eventsUrl)).status, 401);
        for (const client of [owner, recipient, viewer, reconnected])
          client.doc.destroy();
      } finally {
        await Promise.all(
          streams.map((reader) => reader.cancel().catch(() => {})),
        );
        for (const socket of sockets)
          if (socket?.readyState === 1) socket.close();
        await eventually(async () => {
          const response = await fetch(
            `${origin}/fixture/subscribers/${projectId}`,
          );
          const state: unknown = await response.json();
          return (
            typeof state === "object" &&
            state !== null &&
            "recipients" in state &&
            state.recipients === 0
          );
        }, "Upstream compiler subscriptions were not cancelled");
        await db.delete(project).where(eq(project.id, projectId));
        if (ownership === "organization")
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
      }
    }
  }
}
