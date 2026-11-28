import assert from "node:assert/strict";

import { build } from "esbuild";
import { chromium } from "playwright";
import * as Y from "yjs";

import {
  decodeClientMessage,
  decodeMultiplexClientMessage,
  encodeMultiplexServerMessage,
  encodeServerMessage,
  multiplexCollaborationProtocol,
  protocolSearchParam,
} from "#/lib/collaboration";

import type { CacheTestApi } from "./collaboration-cache/browser";

declare global {
  interface Window {
    cacheTest: CacheTestApi;
  }
}

const bundle = await build({
  entryPoints: [
    new URL("./collaboration-cache/browser.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
});
const client = bundle.outputFiles[0]?.text;
assert(client);
const sources = new Map<string, Y.Doc>();
function sourceOf(nodeId: string) {
  const existing = sources.get(nodeId);
  if (existing) return existing;
  const source = new Y.Doc();
  source.getText("source").insert(0, "Saved server source");
  sources.set(nodeId, source);
  return source;
}
// Every socket opened, the open ones per file, and the files sent updates.
const opened: string[] = [];
const connected = new Map<string, number>();
const updates: string[] = [];
async function eventually(
  check: () => boolean | Promise<boolean>,
  label: string,
) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
let rejectSignOut = false;
let signOutRequests = 0;
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  websocket: {
    data: { nodeId: "", multiplex: false, docs: new Set<string>() },
    open(socket) {
      if (socket.data.multiplex) return;
      opened.push(socket.data.nodeId);
      connected.set(
        socket.data.nodeId,
        (connected.get(socket.data.nodeId) ?? 0) + 1,
      );
    },
    close(socket) {
      if (socket.data.multiplex) {
        for (const nodeId of socket.data.docs)
          connected.set(nodeId, (connected.get(nodeId) ?? 1) - 1);
        socket.data.docs.clear();
        return;
      }
      connected.set(
        socket.data.nodeId,
        (connected.get(socket.data.nodeId) ?? 1) - 1,
      );
    },
    message(socket, raw) {
      if (raw === "ping") {
        socket.send("pong");
        return;
      }
      if (socket.data.multiplex) {
        const message = decodeMultiplexClientMessage(raw);
        const { nodeId } = message;
        if (message.type === "close") {
          if (socket.data.docs.delete(nodeId))
            connected.set(nodeId, (connected.get(nodeId) ?? 1) - 1);
          return;
        }
        const source = sourceOf(nodeId);
        if (message.type === "update" && nodeId !== "node") {
          updates.push(nodeId);
          Y.applyUpdate(source, message.update);
        }
        if (message.type === "save")
          socket.send(
            encodeMultiplexServerMessage({
              type: "saved",
              nodeId,
              id: message.id,
              value: source.getText("source").toString(),
              objectKey: "saved",
              updatedAt: Date.now(),
            }),
          );
        if (message.type === "sync") {
          if (!socket.data.docs.has(nodeId)) {
            socket.data.docs.add(nodeId);
            opened.push(nodeId);
            connected.set(nodeId, (connected.get(nodeId) ?? 0) + 1);
          }
          socket.send(
            encodeMultiplexServerMessage({
              type: "sync",
              nodeId,
              update: Y.encodeStateAsUpdate(source),
              vector: Y.encodeStateVector(source),
              dirty: true,
              objectKey: null,
              canWrite: true,
              user: { name: "Cache test", color: "#123456" },
            }),
          );
        }
        return;
      }
      const message = decodeClientMessage(raw);
      const source = sourceOf(socket.data.nodeId);
      // The sign-out checks expect the server copy to stay as it was.
      if (message.type === "update" && socket.data.nodeId !== "node") {
        updates.push(socket.data.nodeId);
        Y.applyUpdate(source, message.update);
      }
      if (message.type === "save")
        socket.send(
          encodeServerMessage({
            type: "saved",
            id: message.id,
            value: source.getText("source").toString(),
            objectKey: "saved",
            updatedAt: Date.now(),
          }),
        );
      if (message.type === "sync")
        socket.send(
          encodeServerMessage({
            type: "sync",
            update: Y.encodeStateAsUpdate(source),
            vector: Y.encodeStateVector(source),
            dirty: true,
            objectKey: null,
            canWrite: true,
            user: { name: "Cache test", color: "#123456" },
          }),
        );
    },
  },
  fetch(request, server) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname.startsWith("/api/collaboration/")) {
      const multiplex =
        url.searchParams.get(protocolSearchParam) ===
        multiplexCollaborationProtocol;
      if (
        server.upgrade(request, {
          data: {
            nodeId: multiplex ? "" : (pathname.split("/").at(-1) ?? ""),
            multiplex,
            docs: new Set<string>(),
          },
        })
      )
        return;
      return new Response(null, { status: 400 });
    }
    if (pathname === "/api/auth/sign-out") {
      signOutRequests++;
      return Response.json(
        rejectSignOut ? { message: "Unavailable" } : { success: true },
        {
          status: rejectSignOut ? 500 : 200,
        },
      );
    }
    if (pathname === "/client.js")
      return new Response(client, {
        headers: { "Content-Type": "text/javascript" },
      });
    return new Response(
      pathname === "/"
        ? "Signed out"
        : '<script type="module" src="/client.js"></script>',
      {
        headers: { "Content-Type": "text/html" },
      },
    );
  },
});
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  context.on("page", (tab) =>
    tab.on("pageerror", (error) => errors.push(error.message)),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = backend.url.origin;
  await page.goto(`${origin}/fixture`);
  await page.waitForFunction(() => !!window.cacheTest);
  const owner = "texfolia.yjs.owner.project.node";
  const closed = "texfolia.yjs.owner.closed.file";
  const other = "texfolia.yjs.owner-other.project.node";
  const unrelated = "another-app-cache";
  await page.evaluate(
    async ({ owner, closed, other, unrelated }) => {
      await window.cacheTest.seed(owner, "Private offline text");
      await window.cacheTest.seed(closed, "Closed document draft");
      await window.cacheTest.seed(other, "Another user’s draft");
      await window.cacheTest.seed(unrelated, "Unrelated data");
      localStorage.setItem("texfolia.settings.v2:owner", "keep preferences");
      localStorage.setItem(
        "texfolia.project.old-project.sources",
        "Private legacy draft",
      );
      localStorage.setItem(
        "texfolia.workspace.layout.v1:owner:project",
        "Private Markdown preview",
      );
      localStorage.setItem(
        "texfolia.workspace.layout.v1:owner-other:project",
        "Other user layout",
      );
      localStorage.setItem("unrelated-key", "keep unrelated data");
    },
    { owner, closed, other, unrelated },
  );

  rejectSignOut = true;
  await assert.rejects(
    page.evaluate(() => window.cacheTest.signOut("owner")),
    /Could not sign out/,
  );
  assert.deepEqual(
    await page.evaluate(() => window.cacheTest.names()),
    [unrelated, closed, owner, other].sort(),
  );
  rejectSignOut = false;

  await page.evaluate((name) => window.cacheTest.block(name), owner);
  await assert.rejects(
    page.evaluate(() => window.cacheTest.signOut("owner")),
    /signed out, but local document copies could not be removed/,
  );
  await page.evaluate(() => window.cacheTest.unblock());
  await page.evaluate(() => window.cacheTest.signOut("owner"));
  assert.deepEqual(
    await page.evaluate(() => window.cacheTest.names()),
    [unrelated, other].sort(),
  );
  assert.equal(
    await page.evaluate((name) => window.cacheTest.read(name), other),
    "Another user’s draft",
  );
  assert.equal(
    await page.evaluate(
      (name) => localStorage.getItem(name),
      "texfolia.settings.v2:owner",
    ),
    "keep preferences",
  );
  assert.equal(signOutRequests, 3);
  assert.deepEqual(
    await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))),
    {
      "texfolia.settings.v2:owner": "keep preferences",
      "texfolia.workspace.layout.v1:owner-other:project": "Other user layout",
      "unrelated-key": "keep unrelated data",
    },
  );

  const editor = await context.newPage();
  await editor.goto(`${origin}/editor`);
  await editor.waitForFunction(() => !!window.cacheTest);
  await editor.evaluate(() => window.cacheTest.open("owner"));
  assert.equal(
    await editor.evaluate(() => window.cacheTest.value()),
    "Saved server source",
  );
  await context.setOffline(true);
  await editor.waitForFunction(() => !window.cacheTest.connected());
  await editor.evaluate(() =>
    window.cacheTest.replace("Unsynced offline edit"),
  );
  // Cached documents from earlier sessions are also removed, including offline edits.
  assert.equal(
    await page.evaluate((name) => window.cacheTest.read(name), owner),
    "Unsynced offline edit",
  );
  await context.setOffline(false);
  await page.evaluate(() => window.cacheTest.signOut("owner"));
  await editor.waitForURL(`${origin}/`);
  assert.deepEqual(
    await page.evaluate(() => window.cacheTest.names()),
    [unrelated, other].sort(),
  );

  await page.evaluate(() => window.cacheTest.open("next-user"));
  assert.equal(
    await page.evaluate(() => window.cacheTest.value()),
    "Saved server source",
  );
  await editor.goto(`${origin}/editor`);
  await editor.waitForFunction(() => !!window.cacheTest);
  await editor.evaluate(() => window.cacheTest.open("owner"));
  assert.equal(
    await editor.evaluate(() => window.cacheTest.value()),
    "Saved server source",
  );

  console.info("Checking documents connect on demand");
  await context.close();
  const projectContext = await browser.newContext();
  const ids = ["main", "closed", "cached", "never"];
  async function openProject() {
    const tab = await projectContext.newPage();
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto(`${origin}/fixture`);
    await tab.waitForFunction(() => !!window.cacheTest);
    return tab;
  }
  let tab = await openProject();
  // A cached edit marked unsynced by an earlier session must merge on open.
  await tab.evaluate(async () => {
    await window.cacheTest.seed(
      "texfolia.yjs.demand.project.cached",
      "Old edit. ",
    );
    localStorage.setItem("texfolia.unsynced.demand.project.cached.1", "1");
  });
  opened.length = 0;
  await tab.evaluate((ids) => window.cacheTest.openProject("demand", ids), ids);
  await eventually(
    () => sourceOf("cached").getText("source").toString().includes("Old edit"),
    "A marked unsynced cache must merge without opening its file",
  );
  await eventually(
    async () =>
      (await tab.evaluate(() => window.cacheTest.documents())).length === 0,
    "A recovered document must close once saved",
  );
  assert.deepEqual(opened, ["cached"], "Unopened files must not connect");
  await tab.evaluate(() => window.cacheTest.hold("main"));
  await eventually(
    () => connected.get("main") === 1,
    "Open file not connected",
  );
  await tab.evaluate(() => window.cacheTest.synchronized());
  assert.deepEqual(opened, ["cached", "main"]);

  // Opening and closing a file whose history has deletions writes nothing.
  sourceOf("main").getText("source").delete(0, 6);
  updates.length = 0;
  await tab.evaluate(() => window.cacheTest.release("main"));
  await eventually(
    () => connected.get("main") === 0,
    "Closed file kept a socket",
  );
  await tab.evaluate(() => window.cacheTest.hold("main"));
  assert.deepEqual(await tab.evaluate(() => window.cacheTest.synchronized()), [
    "main",
  ]);
  assert.deepEqual(updates, [], "A clean document must not send an update");

  // An edit to an unopened file connects it until the edit is saved.
  await tab.evaluate(() => window.cacheTest.edit("never", "Programmatic"));
  await eventually(
    () => sourceOf("never").getText("source").toString() === "Programmatic",
    "An unopened file must accept an edit",
  );
  await eventually(
    () => connected.get("never") === 0,
    "Edited file kept a socket",
  );
  assert.equal(
    (await tab.evaluate(() => window.cacheTest.closedValues())).never,
    "Programmatic",
  );
  assert.deepEqual(
    await tab.evaluate(() => window.cacheTest.markers()),
    [],
    "Saved edits must leave no unsynced markers",
  );

  // Closing an offline file keeps its unsaved edit, then saves it and closes.
  await tab.evaluate(() => window.cacheTest.hold("closed"));
  await tab.evaluate(() => window.cacheTest.synchronized());
  await projectContext.setOffline(true);
  await tab.waitForFunction(() =>
    window.cacheTest.documents().every((document) => !document.connected),
  );
  await tab.evaluate(() => window.cacheTest.edit("closed", "Offline one"));
  await tab.evaluate(() => window.cacheTest.release("closed"));
  await tab.waitForTimeout(600);
  assert.deepEqual(
    (await tab.evaluate(() => window.cacheTest.documents()))
      .map(({ id, value }) => `${id}: ${value}`)
      .sort(),
    ["closed: Offline one", "main: server source"],
    "An unsaved document must stay live after its tab closes",
  );
  await projectContext.setOffline(false);
  await eventually(
    () => sourceOf("closed").getText("source").toString() === "Offline one",
    "Reconnecting must save a closed file's edit",
  );
  await eventually(
    () => connected.get("closed") === 0,
    "Saved file kept a socket",
  );

  // An edit left offline when the page closes merges in the next session.
  await tab.evaluate(() => window.cacheTest.hold("closed"));
  await tab.evaluate(() => window.cacheTest.synchronized());
  await projectContext.setOffline(true);
  await tab.waitForFunction(() =>
    window.cacheTest.documents().every((document) => !document.connected),
  );
  await tab.evaluate(() => window.cacheTest.edit("closed", "Offline two"));
  assert.equal(
    (await tab.evaluate(() => window.cacheTest.markers())).length,
    1,
  );
  await tab.close();
  await projectContext.setOffline(false);
  tab = await openProject();
  opened.length = 0;
  await tab.evaluate((ids) => window.cacheTest.openProject("demand", ids), ids);
  assert.deepEqual(
    await tab.evaluate(() => window.cacheTest.synchronized()),
    ["closed"],
    "Compiling must wait for recovered edits",
  );
  await eventually(
    () => sourceOf("closed").getText("source").toString() === "Offline two",
    "An earlier session's edit must merge without opening its file",
  );
  await eventually(
    () => connected.get("closed") === 0,
    "Recovered file kept a socket",
  );
  assert.deepEqual(opened, ["closed"]);
  assert.deepEqual(await tab.evaluate(() => window.cacheTest.markers()), []);
  await projectContext.close();
  assert.deepEqual(errors, []);
  console.info(
    "Collaboration cache checks passed: user isolation, closed documents, failed sign-out, blocked deletion and retry, open offline editor cleanup, fresh synchronization, and on-demand documents.",
  );
} finally {
  await browser.close();
  await backend.stop(true);
  for (const source of sources.values()) source.destroy();
}
