import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@texfolia/db";
import {
  projectCollaborator,
  projectNode,
  session,
  user,
} from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import { build } from "esbuild";
import {
  convertV4MiniflareOptions,
  Miniflare,
  type MessageEvent as RuntimeMessageEvent,
} from "miniflare";
import { chromium, type BrowserContext } from "playwright";
import * as Y from "yjs";

import {
  decodeServerMessage,
  encodeClientMessage,
  outdatedClientMessage,
  type ServerMessage,
} from "#/features/collaboration";
import { hashSource } from "#/features/compile";

import { createProject } from "../src/features/projects/project.server";
import type { BrowserApi } from "./collaboration/browser";
import { checkDeletion } from "./collaboration/deletion";
import { checkRevocation } from "./collaboration/revocation";
import { checkShareLinks } from "./collaboration/share-links";

declare global {
  interface Window {
    collaborationTest: BrowserApi;
  }
}
const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Set INTEGRATION_DATABASE_URL to an isolated Postgres test database",
);
const db = createDb(connectionString);
const authSecret = "collaboration-integration-secret-not-for-production";
const cookies = new Map<string, string>();
const directory = await mkdtemp(join(tmpdir(), "texfolia-collaboration-"));
const workerBuild = await build({
  entryPoints: [new URL("./collaboration/worker.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd"],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire("file:///worker.js");',
  },
  external: [
    ...builtinModules,
    "node:*",
    "cloudflare:workers",
    "cloudflare:sockets",
    "#tanstack-router-entry",
    "#tanstack-start-entry",
    "tanstack-start-manifest:v",
  ],
  define: { "import.meta.env.DEV": "false" },
});
const clientBuild = await build({
  entryPoints: [
    new URL("./collaboration/browser.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const script = workerBuild.outputFiles[0]?.text;
const client = clientBuild.outputFiles[0]?.text;
assert(script && client);
const runtimeOptions = {
  ...convertV4MiniflareOptions({
    name: "collaboration-test",
    modules: true,
    script,
    compatibilityDate: "2026-10-30",
    compatibilityFlags: ["nodejs_compat", "enable_nodejs_fs_module"],
    durableObjects: {
      COLLABORATION: { className: "ProjectCollaboration", useSQLite: true },
      COMPILER_STREAMS: { className: "CompilerFixture", useSQLite: true },
    },
    r2Buckets: ["SOURCES"],
    hyperdrives: { HYPERDRIVE: connectionString },
    unsafeInspectDurableObjects: true,
    bindings: {
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: "http://localhost",
      STRIPE_SECRET_KEY: "sk_test_collaboration_fixture",
      GITHUB_CLIENT_ID: "fixture",
      GITHUB_CLIENT_SECRET: "fixture",
      GOOGLE_CLIENT_ID: "fixture",
      GOOGLE_CLIENT_SECRET: "fixture",
      GITLAB_CLIENT_ID: "fixture",
      GITLAB_CLIENT_SECRET: "fixture",
      MICROSOFT_CLIENT_ID: "fixture",
      MICROSOFT_CLIENT_SECRET: "fixture",
    },
    serviceBindings: {
      COMPILER: {
        name: "collaboration-test",
        entrypoint: "CompilerServiceFixture",
      },
      CLIENT: () =>
        new Response(client, {
          headers: { "Content-Type": "text/javascript" },
        }),
    },
  }),
  resourcePersistencePath: directory,
};
let mf = new Miniflare(runtimeOptions);
const browser = await chromium.launch({ headless: true });
const contexts: BrowserContext[] = [];
const userIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const [ownerId, editorId, viewerId] = userIds;
assert(ownerId && editorId && viewerId);
try {
  for (const id of userIds) {
    await db.insert(user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const token = crypto.randomUUID();
    await db.insert(session).values({
      id: crypto.randomUUID(),
      token,
      userId: id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const signature = createHmac("sha256", authSecret)
      .update(token)
      .digest("base64");
    cookies.set(
      id,
      `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    );
  }
  await checkDeletion({
    mf,
    db,
    origin: (await mf.ready).origin,
    ownerId,
    cookie: cookies.get(ownerId) ?? "",
  });
  const created = await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: "Collaboration test" },
  });
  const projectId = created.id;
  const node = await db.query.projectNode.findFirst({
    where: { projectId, name: "main.tex" },
  });
  assert(node);
  const nodeId = node.id;
  let bucket = await mf.getR2Bucket("SOURCES");
  const initialBytes = new TextEncoder().encode("existing source");
  const initialKey = `projects/${projectId}/sources/${await hashSource(initialBytes)}`;
  await bucket.put(initialKey, initialBytes);
  await db
    .update(projectNode)
    .set({ objectKey: initialKey, sizeBytes: BigInt(initialBytes.length) })
    .where(eq(projectNode.id, nodeId));
  await db.insert(projectCollaborator).values([
    { projectId, userId: editorId, role: "editor" },
    { projectId, userId: viewerId, role: "viewer" },
  ]);
  const origin = (await mf.ready).origin;
  async function open(userId: string, viewer = false) {
    const context = await browser.newContext();
    contexts.push(context);
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: cookies.get(userId)?.split("=").slice(1).join("=") ?? "",
        url: origin,
      },
    ]);
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });
    page.on("websocket", (socket) => {
      socket.on("framereceived", (event) => {
        const text = String(event.payload);
        if (text.includes('"type":"error"')) console.error(text);
      });
    });
    page.on("pageerror", (error) => {
      throw error;
    });
    await page.goto(
      `${origin}/?projectId=${projectId}&nodeId=${nodeId}&userId=${userId}&viewer=${viewer ? 1 : 0}`,
    );
    try {
      await page.waitForFunction(
        () => window.collaborationTest?.status().connected,
      );
    } catch (error) {
      console.error(
        await page.evaluate(() => window.collaborationTest?.status()),
      );
      throw error;
    }
    return { page, context };
  }
  console.log("Checking connect");
  const a = await open(ownerId);
  const b = await open(editorId);
  const viewer = await open(viewerId, true);
  assert.equal(
    await a.page.evaluate(() => window.collaborationTest.value()),
    "existing source",
  );
  assert.equal(
    await b.page.evaluate(() => window.collaborationTest.value()),
    "existing source",
  );
  await a.page.evaluate(() => window.collaborationTest.replace("hello"));
  await b.page.waitForFunction(
    () => window.collaborationTest.value() === "hello",
  );
  await viewer.page.waitForFunction(
    () => window.collaborationTest.editorValue() === "hello",
  );
  assert.equal(
    await viewer.page.locator(".cm-content").getAttribute("contenteditable"),
    "false",
  );
  assert.match(
    await viewer.page.evaluate(() =>
      window.collaborationTest.maliciousUpdate(),
    ),
    /Viewers cannot edit/,
  );
  assert.equal(
    await a.page.evaluate(() => window.collaborationTest.value()),
    "hello",
  );

  if (process.env.CHECK_COLLABORATION_LATENCY === "1") {
    // Date.now() uses the same host clock in these isolated Chromium contexts.
    // Time the edit dispatch through the receiver's CodeMirror update, excluding
    // runner polling. This local acceptance gate does not predict deployed latency.
    const samples: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (const [sender, receiver] of [
        [a, b],
        [b, a],
      ]) {
        assert(sender && receiver);
        const before = await sender.page.evaluate(() =>
          window.collaborationTest.value(),
        );
        const prefix = `warm-${round}|`;
        const startedAt = await sender.page.evaluate(
          (prefix) => window.collaborationTest.insert(0, prefix),
          prefix,
        );
        await receiver.page.waitForFunction(
          (expected) => window.collaborationTest.editorValue() === expected,
          prefix + before,
        );
        const receivedAt = await receiver.page.evaluate(() =>
          window.collaborationTest.updatedAt(),
        );
        samples.push(receivedAt - startedAt);
      }
    }
    assert(
      samples.every((sample) => sample >= 0 && sample <= 200),
      JSON.stringify(samples),
    );
    console.log(
      "Warm local propagation met 200 ms gate",
      JSON.stringify(samples),
    );
    await a.page.evaluate(() => window.collaborationTest.replace("hello"));
    await b.page.waitForFunction(
      () => window.collaborationTest.value() === "hello",
    );
  }

  console.log("Checking offline convergence");
  // Both peers edit the same base while disconnected, then merge their updates.
  await Promise.all([a.context.setOffline(true), b.context.setOffline(true)]);
  await Promise.all([
    a.page.waitForFunction(() => !window.collaborationTest.status().connected),
    b.page.waitForFunction(() => !window.collaborationTest.status().connected),
  ]);
  await a.page.evaluate(() => window.collaborationTest.insert(5, " Alice"));
  await b.page.evaluate(() => window.collaborationTest.insert(5, " Bob"));
  await Promise.all([a.context.setOffline(false), b.context.setOffline(false)]);
  await Promise.all([
    a.page.waitForFunction(
      () =>
        window.collaborationTest.status().connected &&
        window.collaborationTest.value().includes("Bob"),
    ),
    b.page.waitForFunction(
      () =>
        window.collaborationTest.status().connected &&
        window.collaborationTest.value().includes("Alice"),
    ),
  ]);
  const merged = await a.page.evaluate(() => window.collaborationTest.value());
  assert.equal(
    await b.page.evaluate(() => window.collaborationTest.value()),
    merged,
  );
  assert.match(merged, /Alice/);
  assert.match(merged, /Bob/);
  await a.page.evaluate(() => window.collaborationTest.undo());
  await b.page.waitForFunction(
    () => !window.collaborationTest.value().includes("Alice"),
  );
  assert.match(
    await b.page.evaluate(() => window.collaborationTest.value()),
    /Bob/,
  );

  console.log("Checking project-wide presence");
  // Tabs connect only to open files, so the room lists everyone in the project.
  const otherId = crypto.randomUUID();
  await db.insert(projectNode).values({
    id: otherId,
    projectId,
    parentId: node.parentId,
    kind: "text",
    name: "other.tex",
    sizeBytes: 0n,
  });
  async function joinOther(userId: string, people: boolean) {
    const response = await mf.dispatchFetch(
      `${origin}/api/collaboration/${projectId}/${otherId}?protocol=2&clientId=777${people ? "&people=1" : ""}`,
      {
        headers: {
          Upgrade: "websocket",
          Cookie: cookies.get(userId) ?? "",
          Origin: origin,
        },
      },
    );
    const socket = response.webSocket;
    assert(socket);
    const messages: ServerMessage[] = [];
    socket.addEventListener("message", (event) => {
      messages.push(decodeServerMessage(event.data));
    });
    socket.accept();
    socket.send(
      encodeClientMessage({
        type: "sync",
        vector: Y.encodeStateVector(new Y.Doc()),
      }),
    );
    for (let attempt = 0; !messages.length && attempt < 200; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    return { socket, messages };
  }
  const named = (names: string[]) =>
    a.page.waitForFunction(
      (expected) =>
        window.collaborationTest.people().sort().join() === expected,
      [...names].sort().join(),
    );
  await named([ownerId, editorId, viewerId]);
  await viewer.context.close();
  await named([ownerId, editorId]);
  const joined = await joinOther(viewerId, true);
  await named([ownerId, editorId, viewerId]);
  const joinedPeople = joined.messages.find(
    (message) => message.type === "people",
  );
  assert(joinedPeople?.type === "people");
  assert.equal(joinedPeople.people.length, 3);
  const unaware = await joinOther(ownerId, false);
  joined.socket.close();
  await named([ownerId, editorId]);
  assert(
    !unaware.messages.some((message) => message.type === "people"),
    "Tabs that do not ask for people must not receive them",
  );
  unaware.socket.close();

  console.log("Checking cursors and formatting");
  // Cursor positions follow minimal formatting edits, and names come from the server.
  await a.page.evaluate(() => window.collaborationTest.replace("alpha beta"));
  await b.page.waitForFunction(
    () => window.collaborationTest.value() === "alpha beta",
  );
  await b.page.bringToFront();
  const bClient = await b.page.evaluate(() => {
    window.collaborationTest.select(6, 10);
    return window.collaborationTest.clientId();
  });
  await a.page.waitForFunction(
    (id) => window.collaborationTest.cursorIndex(id) === 6,
    bClient,
  );
  console.log("Cursor received; applying minimal diff");
  await a.page.evaluate(() => window.collaborationTest.format("alpha\n  beta"));
  await b.page.waitForFunction(
    () => window.collaborationTest.editorValue() === "alpha\n  beta",
  );
  await a.page.waitForFunction(
    (id) => window.collaborationTest.cursorIndex(id) === 8,
    bClient,
  );
  const presence = await a.page.evaluate(() =>
    window.collaborationTest.presence(),
  );
  assert(presence.some((state) => state.userName === editorId));
  assert((await a.page.locator(".cm-ySelectionCaret").count()) > 0);

  console.log("Checking hibernation");
  // Eviction must restore SQLite state and attached awareness without closing sockets.
  await a.page.evaluate(() => window.collaborationTest.save());
  await mf.unsafeEvictDurableObject(
    "collaboration-test",
    "ProjectCollaboration",
    { name: projectId, webSockets: "hibernate" },
  );
  await a.page.evaluate(() => window.collaborationTest.insert(12, "!"));
  await b.page.waitForFunction(
    () => window.collaborationTest.value() === "alpha\n  beta!",
  );
  await a.page.evaluate(() => window.collaborationTest.save());

  console.log("Checking interrupted source flush after runtime restart");
  let storage = await mf.unsafeGetDurableObjectStorage(
    "collaboration-test",
    "ProjectCollaboration",
    { name: projectId },
  );
  await storage.exec(
    "UPDATE documents SET object_key = NULL, dirty = 1 WHERE node_id = ?",
    nodeId,
  );
  await mf.dispose();
  await a.page.waitForFunction(
    () => !window.collaborationTest.status().connected,
  );
  mf = new Miniflare({ ...runtimeOptions, port: Number(new URL(origin).port) });
  await mf.ready;
  bucket = await mf.getR2Bucket("SOURCES");
  await a.page.waitForFunction(
    () => window.collaborationTest.status().connected,
  );
  await b.page.waitForFunction(
    () => window.collaborationTest.status().connected,
  );
  storage = await mf.unsafeGetDurableObjectStorage(
    "collaboration-test",
    "ProjectCollaboration",
    { name: projectId },
  );
  await a.page.evaluate(() => window.collaborationTest.save());

  console.log("Checking offline reload");
  // Offline Yjs identities survive a browser reload and merge, rather than duplicating source text.
  await a.context.setOffline(true);
  await a.page.waitForFunction(
    () => !window.collaborationTest.status().connected,
  );
  await a.page.evaluate(() => window.collaborationTest.insert(13, " offline"));
  await a.context.setOffline(false);
  await a.page.reload();
  await a.page.waitForFunction(
    () =>
      window.collaborationTest?.status().connected &&
      window.collaborationTest.value().endsWith(" offline"),
  );
  await b.page.waitForFunction(() =>
    window.collaborationTest.value().endsWith(" offline"),
  );

  console.log("Checking compaction and persistence");
  // Compact a long update journal; the live CRDT identifiers must still merge after compaction.
  for (let i = 0; i < 70; i++)
    await a.page.evaluate(() => window.collaborationTest.insert(0, "x"));
  const expectedText = await a.page.evaluate(() =>
    window.collaborationTest.value(),
  );
  const expectedKey = `projects/${projectId}/sources/${await hashSource(new TextEncoder().encode(expectedText))}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = await db.query.projectNode.findFirst({ where: { id: nodeId } });
    if (row?.objectKey === expectedKey) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    (await db.query.projectNode.findFirst({ where: { id: nodeId } }))
      ?.objectKey,
    expectedKey,
    "Alarm must persist merged text without Save",
  );
  const saved = await a.page.evaluate(() => window.collaborationTest.save());

  const count = await storage.exec<{ count: number }>(
    "SELECT count(*) AS count FROM updates",
  );
  assert((count[0]?.count ?? 1000) < 64);
  assert.equal(await (await bucket.get(saved.objectKey))?.text(), saved.value);
  const row = await db.query.projectNode.findFirst({ where: { id: nodeId } });
  assert.equal(row?.objectKey, saved.objectKey);
  assert.equal(
    row?.sizeBytes,
    BigInt(new TextEncoder().encode(saved.value).length),
  );
  const fresh = await open(ownerId);
  assert.equal(
    await fresh.page.evaluate(() => window.collaborationTest.value()),
    saved.value,
  );

  console.log("Checking multi-chunk document persistence");
  const largeId = crypto.randomUUID();
  const largeText = "L".repeat(9 * 1024 * 1024);
  const largeBytes = new TextEncoder().encode(largeText);
  const largeKey = `projects/${projectId}/sources/${await hashSource(largeBytes)}`;
  await bucket.put(largeKey, largeBytes);
  await db.insert(projectNode).values({
    id: largeId,
    projectId,
    parentId: node.parentId,
    kind: "text",
    name: "large.txt",
    objectKey: largeKey,
    sizeBytes: BigInt(largeBytes.length),
  });
  const largeResponse = await mf.dispatchFetch(
    `${origin}/api/collaboration/${projectId}/${largeId}?protocol=2&clientId=12345`,
    {
      headers: {
        Upgrade: "websocket",
        Cookie: cookies.get(ownerId) ?? "",
        Origin: origin,
      },
    },
  );
  let largeSocket = largeResponse.webSocket;
  assert(largeSocket);
  largeSocket.accept();
  function largeMessage(
    expected: { type: "sync" | "error" } | { type: "saved"; id: string },
  ) {
    const socket = largeSocket;
    assert(socket);
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.removeEventListener("message", listener);
        reject(new Error(`Large document ${expected.type} timed out`));
      }, 20_000);
      const listener = (event: RuntimeMessageEvent) => {
        try {
          const message = decodeServerMessage(event.data);
          if (expected.type === "saved") {
            if (
              (message.type !== "saved" && message.type !== "error") ||
              message.id !== expected.id
            )
              return;
          } else if (message.type !== expected.type) return;
          if (message.type === "error" && expected.type !== "error")
            throw new Error(message.message);
          clearTimeout(timer);
          socket.removeEventListener("message", listener);
          resolve(message);
        } catch (error) {
          clearTimeout(timer);
          socket.removeEventListener("message", listener);
          reject(error);
        }
      };
      socket.addEventListener("message", listener);
    });
  }
  const largeDoc = new Y.Doc();
  const synced = largeMessage({ type: "sync" });
  largeSocket.send(
    encodeClientMessage({
      type: "sync",
      vector: Y.encodeStateVector(largeDoc),
    }),
  );
  const initialLarge = await synced;
  assert(initialLarge.type === "sync");
  Y.applyUpdate(largeDoc, initialLarge.update);
  assert.equal(largeDoc.getText("source").toString(), largeText);
  largeDoc.getText("source").insert(0, "large ");
  const largeSaveId = crypto.randomUUID();
  const largeSaved = largeMessage({ type: "saved", id: largeSaveId });
  largeSocket.send(
    encodeClientMessage({
      type: "update",
      update: Y.encodeStateAsUpdate(largeDoc),
    }),
  );
  largeSocket.send(encodeClientMessage({ type: "save", id: largeSaveId }));
  const storedLarge = await largeSaved;
  assert(storedLarge.type === "saved");
  assert.equal(storedLarge.value, "large " + largeText);
  assert.equal(
    await (await bucket.get(storedLarge.objectKey))?.text(),
    storedLarge.value,
  );
  const chunks = await storage.exec<{ count: number; size: number }>(
    "SELECT count(*) AS count, max(length(data)) AS size FROM snapshot_chunks WHERE node_id = ?",
    largeId,
  );
  assert(
    (chunks[0]?.count ?? 0) >= 8 &&
      (chunks[0]?.size ?? Infinity) <= 1024 * 1024,
  );
  console.log("Checking payload-free saves of already-sent updates");
  const beforeEdit = Y.encodeStateVector(largeDoc);
  largeDoc.getText("source").insert(0, "sent ");
  largeSocket.send(
    encodeClientMessage({
      type: "update",
      update: Y.encodeStateAsUpdate(largeDoc, beforeEdit),
    }),
  );
  const emptySaveId = crypto.randomUUID();
  const emptySaved = largeMessage({ type: "saved", id: emptySaveId });
  largeSocket.send(encodeClientMessage({ type: "save", id: emptySaveId }));
  const storedEmpty = await emptySaved;
  assert(storedEmpty.type === "saved");
  assert.equal(storedEmpty.value, "sent large " + largeText);
  const cleanSync = largeMessage({ type: "sync" });
  largeSocket.send(
    encodeClientMessage({
      type: "sync",
      vector: Y.encodeStateVector(largeDoc),
    }),
  );
  const clean = await cleanSync;
  assert(clean.type === "sync");
  assert.equal(clean.dirty, false);
  assert.equal(clean.objectKey, storedEmpty.objectKey);
  console.log("Checking recovery after a project quota rejection");
  const assetBytes = new TextEncoder().encode("B".repeat(10 * 1024 * 1024));
  const assetKey = `projects/${projectId}/sources/${await hashSource(assetBytes)}`;
  await bucket.put(assetKey, assetBytes);
  for (let index = 0; index < 4; index++)
    await db.insert(projectNode).values({
      id: crypto.randomUUID(),
      projectId,
      parentId: node.parentId,
      kind: "binary",
      name: `asset-${index}.bin`,
      objectKey: assetKey,
      sizeBytes: BigInt(assetBytes.length),
    });
  const largeSource = largeDoc.getText("source");
  largeSource.insert(
    largeSource.length,
    "q".repeat(10 * 1024 * 1024 - largeSource.length),
  );
  const rejectedSaveId = crypto.randomUUID();
  const rejectedSave = largeMessage({ type: "saved", id: rejectedSaveId });
  largeSocket.send(
    encodeClientMessage({
      type: "update",
      update: Y.encodeStateAsUpdate(largeDoc),
    }),
  );
  largeSocket.send(encodeClientMessage({ type: "save", id: rejectedSaveId }));
  await assert.rejects(rejectedSave, /Project exceeds 50 MiB/);
  largeSocket.close();
  // The failed flush discards the memory cache. Restore the pending SQLite
  // document and shorten it without first having to persist the oversized text.
  const resumed = await mf.dispatchFetch(
    `${origin}/api/collaboration/${projectId}/${largeId}?protocol=2&clientId=12345`,
    {
      headers: {
        Upgrade: "websocket",
        Cookie: cookies.get(ownerId) ?? "",
        Origin: origin,
      },
    },
  );
  assert.equal(resumed.status, 101);
  const resumedSocket = resumed.webSocket;
  assert(resumedSocket);
  largeSocket = resumedSocket;
  resumedSocket.accept();
  const restored = largeMessage({ type: "sync" });
  const backgroundQuotaError = largeMessage({ type: "error" });
  await Promise.all([
    restored,
    backgroundQuotaError.then((message) => {
      assert(message.type === "error");
      assert.equal(message.id, undefined);
      assert.match(message.message, /Project exceeds 50 MiB/);
      resumedSocket.send(
        encodeClientMessage({
          type: "sync",
          vector: Y.encodeStateVector(largeDoc),
        }),
      );
    }),
  ]);
  const restoredSync = await restored;
  assert(restoredSync.type === "sync");
  assert(restoredSync.dirty, "Unflushed documents must report pending saves");
  largeSource.delete(9 * 1024 * 1024, 1024 * 1024);
  const repairedSaveId = crypto.randomUUID();
  const repaired = largeMessage({ type: "saved", id: repairedSaveId });
  largeSocket.send(
    encodeClientMessage({
      type: "update",
      update: Y.encodeStateAsUpdate(largeDoc),
    }),
  );
  largeSocket.send(encodeClientMessage({ type: "save", id: repairedSaveId }));
  const repairedSource = await repaired;
  assert(
    repairedSource.type === "saved" &&
      repairedSource.value.length === 9 * 1024 * 1024,
  );
  largeSocket.close();
  largeDoc.destroy();

  console.log("Checking outdated base64 JSON clients are asked to reload");
  const outdated = await mf.dispatchFetch(
    `${origin}/api/collaboration/${projectId}/${nodeId}?clientId=54321`,
    {
      headers: {
        Upgrade: "websocket",
        Cookie: cookies.get(ownerId) ?? "",
        Origin: origin,
      },
    },
  );
  assert.equal(outdated.status, 101);
  const outdatedSocket = outdated.webSocket;
  assert(outdatedSocket);
  const outdatedFrames: unknown[] = [];
  outdatedSocket.addEventListener("message", (event) => {
    outdatedFrames.push(event.data);
  });
  outdatedSocket.accept();
  outdatedSocket.send(JSON.stringify({ type: "sync", vector: "AA==" }));
  await a.page.evaluate(() => window.collaborationTest.insert(0, "!"));
  const deadline = Date.now() + 10_000;
  while (!outdatedFrames.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  // Give the room time to (wrongly) forward the live edit as a binary frame.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(
    outdatedFrames.map((frame) => decodeServerMessage(frame)),
    [{ type: "error", message: outdatedClientMessage }],
  );
  outdatedSocket.close();

  console.log("Checking permission change");
  // A connected editor downgraded to viewer cannot keep writing through its socket.
  assert.equal(
    (
      await mf.dispatchFetch(`${origin}/access/grant/${projectId}`, {
        method: "POST",
        headers: { "X-Owner": ownerId },
        body: JSON.stringify({
          email: `${editorId}@example.com`,
          role: "viewer",
        }),
      })
    ).status,
    204,
  );
  await b.page.evaluate(() => window.collaborationTest.insert(0, "DENIED"));
  await b.page.waitForFunction(() =>
    window.collaborationTest.status().error.includes("Viewers cannot edit"),
  );
  await fresh.page.evaluate(() => window.collaborationTest.save());
  assert(
    !(await fresh.page.evaluate(() =>
      window.collaborationTest.value().includes("DENIED"),
    )),
  );
  await checkRevocation({
    mf,
    db,
    origin,
    ownerId,
    editorId,
    viewerId,
    cookies,
  });
  await checkShareLinks({ mf, db, origin, ownerId, editorId, cookies });
  console.log(
    "Collaboration passed: convergence, offline merge/reload, viewers, cursors, undo, formatting, hibernation, compaction, R2, fresh browser, permission changes, live WebSocket/SSE/PDF revocation, and share-link guests",
  );
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  await mf.dispatchFetch(`${(await mf.ready).origin}/cleanup/collect`, {
    method: "POST",
  });
  await mf.dispose();
  await db.$client.end();
  await rm(directory, { recursive: true, force: true });
}
