import assert from "node:assert/strict";

import { build } from "esbuild";
import { chromium } from "playwright";
import * as Y from "yjs";

import { encodeSource } from "../src/lib/project-source";
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
const source = new Y.Doc();
source.getText("source").insert(0, "Saved server source");
let rejectSignOut = false;
let signOutRequests = 0;
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  websocket: {
    message(socket, raw) {
      const message = JSON.parse(String(raw));
      if (message.type === "sync")
        socket.send(
          JSON.stringify({
            type: "sync",
            update: encodeSource(Y.encodeStateAsUpdate(source)),
            vector: encodeSource(Y.encodeStateVector(source)),
            dirty: true,
            objectKey: null,
            canWrite: true,
            user: { name: "Cache test", color: "#123456" },
          }),
        );
    },
  },
  fetch(request, server) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/collaboration/")) {
      if (server.upgrade(request)) return;
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
  assert.deepEqual(errors, []);
  console.info(
    "Collaboration cache checks passed: user isolation, closed documents, failed sign-out, blocked deletion and retry, open offline editor cleanup, and fresh synchronization.",
  );
} finally {
  await browser.close();
  backend.stop(true);
  source.destroy();
}
