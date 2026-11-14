import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@texfolia/db";
import {
  project,
  projectCollaborator,
  projectNode,
  session,
  user,
} from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { chromium, type Page } from "playwright";
import * as Y from "yjs";
import { z } from "zod";

import {
  documentVersionSchema,
  historyCadenceMs,
  historyRetentionMs,
} from "../src/lib/document-history";
import { hashSource } from "../src/lib/latex/source-sync";
import { createProject } from "../src/lib/project.server";

declare global {
  interface Window {
    historyTestRpc: (
      action: string,
      data: {
        projectId: string;
        nodeId: string;
        versionId?: string;
        label?: string;
        before?: { createdAt: number; id: string };
      },
    ) => Promise<unknown>;
  }
}
const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Use an isolated Postgres test database",
);
const db = createDb(connectionString);
const root = new URL("../dist/server/", import.meta.url).pathname;
const filenames = await readdir(root, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "texfolia-history-"));
const secret = "document-history-test-secret-not-for-production";
const runtimeOptions = () => {
  const app = convertV4MiniflareOptions({
    name: "document-history-test",
    modules: filenames
      .filter((path) => path.endsWith(".js"))
      .sort((a, b) =>
        a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b),
      )
      .map((path) => ({ type: "ESModule", path: join(root, path) })),
    modulesRoot: root,
    compatibilityDate: "2025-09-02",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      directory: new URL("../dist/client/", import.meta.url).pathname,
      routerConfig: { has_user_worker: true },
    },
    durableObjects: {
      COLLABORATION: { className: "ProjectCollaboration", useSQLite: true },
    },
    r2Buckets: ["SOURCES"],
    hyperdrives: { HYPERDRIVE: connectionString },
    unsafeInspectDurableObjects: true,
    bindings: {
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: "http://localhost",
      STRIPE_SECRET_KEY: "sk_test_history",
      ...Object.fromEntries(
        ["GITHUB", "GITLAB", "GOOGLE", "MICROSOFT"].flatMap((provider) => [
          [`${provider}_CLIENT_ID`, "fixture"],
          [`${provider}_CLIENT_SECRET`, "fixture"],
        ]),
      ),
    },
    serviceBindings: { COMPILER: { name: "history-compiler-fixture" } },
  });
  const compiler = convertV4MiniflareOptions({
    name: "history-compiler-fixture",
    modules: true,
    script: `const snapshot = { revision: 0, current: null, latestBuild: null, stale: false, artifacts: null };
      export default { fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(snapshot) + '\\n\\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } });
        if (path.endsWith('/changed')) return new Response(null, { status: 204 });
        if (path.endsWith('/pdf')) return new Response(null, { status: 404 });
        return Response.json(snapshot);
      } };`,
  });
  return {
    ...app,
    workers: [...app.workers, ...compiler.workers],
    resourcePersistencePath: directory,
  };
};
let mf = new Miniflare(runtimeOptions());
const browser = await chromium.launch({ headless: true });
const userIds = [
  crypto.randomUUID(),
  crypto.randomUUID(),
  crypto.randomUUID(),
  crypto.randomUUID(),
];
const [ownerId, editorId, viewerId, outsiderId] = userIds;
assert(ownerId && editorId && viewerId && outsiderId);
const pages = new Map<string, Page>();
const errors: string[] = [];
let projectId = "";
const pageSchema = z.object({
  versions: z.array(documentVersionSchema),
  next: z.object({ createdAt: z.number(), id: z.uuid() }).nullable(),
});
async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await Bun.sleep(50);
  }
}
try {
  const origin = (await mf.ready).origin;
  const resolverFile = filenames.find(
    (name) =>
      name.includes("tanstack-start-server-fn-resolver") &&
      name.endsWith(".js"),
  );
  assert(resolverFile);
  const resolver = await readFile(join(root, resolverFile), "utf8");
  const actions = [
    "listDocumentHistory",
    "compareDocumentHistory",
    "createDocumentVersion",
    "nameDocumentVersion",
    "restoreDocumentVersion",
    "saveProjectSource",
  ];
  const rpcIds = Object.fromEntries(
    actions.map((name) => {
      const id = resolver.match(
        new RegExp(
          `"([a-f0-9]+)":\\s*\\{\\s*functionName: "${name}_createServerFn_handler"`,
        ),
      )?.[1];
      assert(id, name);
      return [name, id];
    }),
  );
  const rpcBuild = await build({
    stdin: {
      contents: `import { createClientRpc } from "@tanstack/react-start/client-rpc"; const ids = ${JSON.stringify(rpcIds)}; window.historyTestRpc = async (name, data) => { const response = await createClientRpc(ids[name])({ method: name.startsWith("list") || name.startsWith("compare") ? "GET" : "POST", data }); if (response.error) throw response.error; return response.result; };`,
      resolveDir: new URL("../", import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    define: { "process.env.TSS_SERVER_FN_BASE": JSON.stringify("/_serverFn/") },
    plugins: [
      {
        name: "start-client-options",
        setup(builder) {
          builder.onLoad({ filter: /getStartOptions\.js$/ }, () => ({
            contents:
              "export const getStartOptions = () => window.__TSS_START_OPTIONS__;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const rpcScript = rpcBuild.outputFiles[0]?.text;
  assert(rpcScript);
  const cookies = new Map<string, string>();
  for (const [index, id] of userIds.entries()) {
    await db.insert(user).values({
      id,
      name: ["Ada", "Grace", "Viewer", "Outsider"][index] ?? "User",
      email: `${id}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const token = crypto.randomUUID();
    await db.insert(session).values({
      id: crypto.randomUUID(),
      token,
      userId: id,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    cookies.set(
      id,
      encodeURIComponent(
        `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`,
      ),
    );
  }
  const created = await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: "History integration" },
  });
  projectId = created.id;
  await db.insert(projectCollaborator).values([
    { projectId, userId: editorId, role: "editor" },
    { projectId, userId: viewerId, role: "viewer" },
  ]);
  const node = await db.query.projectNode.findFirst({
    where: { projectId, name: "main.tex" },
  });
  assert(node);
  const nodeId = node.id;
  let bucket = await mf.getR2Bucket("SOURCES");
  const initial = "Initial source\n";
  const bytes = new TextEncoder().encode(initial);
  const objectKey = `projects/${projectId}/sources/${await hashSource(bytes)}`;
  await bucket.put(objectKey, bytes);
  await db
    .update(projectNode)
    .set({ objectKey, sizeBytes: BigInt(bytes.length) })
    .where(eq(projectNode.id, node.id));
  for (const id of userIds) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: cookies.get(id) ?? "",
        url: origin,
      },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${origin}/${id === outsiderId ? "projects" : `project/${projectId}`}`,
    );
    await page.addScriptTag({ content: rpcScript });
    pages.set(id, page);
  }
  const owner = pages.get(ownerId);
  const editor = pages.get(editorId);
  const viewer = pages.get(viewerId);
  const outsider = pages.get(outsiderId);
  assert(owner && editor && viewer && outsider);
  async function rpc(
    page: Page,
    action: string,
    extra: {
      versionId?: string;
      label?: string;
      nodeId?: string;
      content?: string;
      expectedObjectKey?: string | null;
      before?: { createdAt: number; id: string };
    } = {},
  ) {
    return page.evaluate(
      ({ action, data }) => window.historyTestRpc(action, data),
      { action, data: { projectId, nodeId, ...extra } },
    );
  }
  async function list(page?: Page) {
    const target = page ?? pages.get(ownerId ?? "");
    assert(target);
    return pageSchema.parse(await rpc(target, "listDocumentHistory"));
  }
  const edit = editor.locator('.cm-content[contenteditable="true"]').first();
  await edit.waitFor();
  assert.equal((await list()).versions.length, 0);
  await edit.click();
  await editor.keyboard.press("ControlOrMeta+End");
  await editor.keyboard.insertText("Edited by Grace\n");
  await eventually(
    async () => (await list()).versions.length === 1,
    "first edit archives starting text",
  );
  const baseline = (await list()).versions[0];
  assert(baseline);
  assert.equal(
    z
      .object({ value: z.string() })
      .parse(
        await rpc(owner, "compareDocumentHistory", { versionId: baseline.id }),
      ).value,
    initial,
  );
  let storage = await mf.unsafeGetDurableObjectStorage(
    "document-history-test",
    "ProjectCollaboration",
    { name: projectId },
  );
  const pending = await storage.exec<{ since: number; authors: string }>(
    "SELECT since, authors FROM history_activity WHERE node_id = ?",
    node.id,
  );
  assert.match(pending[0]?.authors ?? "", /Grace/);
  const since = pending[0]?.since;
  assert(since);
  await mf.unsafeEvictDurableObject(
    "document-history-test",
    "ProjectCollaboration",
    { name: projectId, webSockets: "hibernate" },
  );
  await edit.click();
  await editor.keyboard.insertText("More edits\n");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  assert.equal(
    (
      await storage.exec<{ since: number }>(
        "SELECT since FROM history_activity WHERE node_id = ?",
        node.id,
      )
    )[0]?.since,
    since,
    "activity must not postpone cadence",
  );
  await storage.exec(
    "UPDATE history_activity SET since = ?",
    Date.now() - historyCadenceMs - 1,
  );
  await eventually(
    async () => (await list()).versions.length === 2,
    "alarm snapshots pending activity",
  );
  const automatic = (await list()).versions.find(
    (entry) => entry.id !== baseline.id,
  );
  assert(automatic);
  assert(automatic.authors.some((author) => author.name === "Grace"));
  console.info(
    "Checking history panel, live comparison, labels, and downloads",
  );
  await owner
    .getByRole("button", { name: "Document history", exact: true })
    .click();
  await owner.getByLabel("New version name").fill("Submission draft");
  await owner
    .getByRole("button", { name: "Save named version", exact: true })
    .click();
  await owner
    .getByRole("status")
    .filter({ hasText: "Named version saved." })
    .waitFor();
  const named = (await list()).versions.find(
    (entry) => entry.label === "Submission draft",
  );
  assert(named);
  await edit.click();
  await editor.keyboard.press("ControlOrMeta+End");
  await editor.keyboard.insertText("Latest work to preserve\n");
  await owner
    .getByLabel("Version diff")
    .filter({ hasText: "Latest work to preserve" })
    .waitFor();
  const download = owner.waitForEvent("download");
  await owner
    .getByRole("button", { name: "Download version", exact: true })
    .click();
  const downloadPath = await (await download).path();
  assert(downloadPath);
  assert(!(await readFile(downloadPath, "utf8")).includes("Latest work"));
  await owner.screenshot({ path: "/tmp/texfolia-history-desktop.png" });
  await owner.getByLabel("Selected version name").fill("Ready for review");
  await owner
    .getByRole("button", { name: "Name version", exact: true })
    .click();
  await eventually(
    async () =>
      (await list()).versions.some(
        (entry) => entry.label === "Ready for review",
      ),
    "renames version",
  );
  await owner
    .getByRole("button", { name: "Restore this version", exact: true })
    .click();
  await owner.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.match(await edit.innerText(), /Latest work/);
  await owner
    .getByRole("button", { name: "Restore this version", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Confirm restore", exact: true })
    .click();
  await owner
    .getByRole("status")
    .filter({ hasText: "Version restored." })
    .waitFor();
  await eventually(
    async () => !(await edit.innerText()).includes("Latest work"),
    "remote editor receives restore",
  );
  const restored = (await list()).versions;
  const checkpoint = restored.find((entry) => entry.kind === "before-restore");
  assert(checkpoint);
  assert.match(
    z.object({ value: z.string() }).parse(
      await rpc(owner, "compareDocumentHistory", {
        versionId: checkpoint.id,
      }),
    ).value,
    /Latest work/,
  );
  assert(
    restored.some(
      (entry) => entry.kind === "restore" && entry.restoredFrom === named.id,
    ),
  );
  assert(restored.some((entry) => entry.id === baseline.id));
  const namedKey = `history/${projectId}/${node.id}/${named.id}.yjs`;
  const namedObject = await bucket.get(namedKey);
  assert(namedObject);
  const namedBytes = await namedObject.arrayBuffer();
  const beforeMissingRestore = await edit.innerText();
  const beforeMissingCount = (await list()).versions.length;
  await bucket.delete(namedKey);
  await assert.rejects(
    rpc(owner, "restoreDocumentVersion", { versionId: named.id }),
    /missing from storage/,
  );
  assert.equal(await edit.innerText(), beforeMissingRestore);
  assert.equal((await list()).versions.length, beforeMissingCount);
  await bucket.put(namedKey, namedBytes);
  console.info("Checking authorization and retention");
  assert((await list(viewer)).versions.length > 0);
  for (const action of [
    "createDocumentVersion",
    "nameDocumentVersion",
    "restoreDocumentVersion",
  ]) {
    await assert.rejects(
      rpc(viewer, action, { label: "Forbidden", versionId: baseline.id }),
      /Viewers cannot/,
    );
  }
  await assert.rejects(
    rpc(outsider, "listDocumentHistory"),
    /Project not found/,
  );
  await assert.rejects(
    rpc(owner, "compareDocumentHistory", {
      versionId: baseline.id,
      nodeId: crypto.randomUUID(),
    }),
    /File not found/,
  );
  await assert.rejects(rpc(owner, "createDocumentVersion", { label: " " }));
  await storage.exec(
    "UPDATE history_versions SET created_at = ?",
    Date.now() - historyRetentionMs - 1000,
  );
  const retained = (await list()).versions;
  assert.deepEqual(
    retained.map((entry) => entry.id),
    [named.id],
  );
  assert.equal(
    await bucket.get(`history/${projectId}/${node.id}/${baseline.id}.yjs`),
    null,
  );
  assert(await bucket.get(`history/${projectId}/${node.id}/${named.id}.yjs`));
  await rpc(owner, "restoreDocumentVersion", { versionId: named.id });
  // A second document cannot read versions belonging to the first one.
  const otherId = crypto.randomUUID();
  await db.insert(projectNode).values({
    id: otherId,
    projectId,
    parentId: node.parentId,
    kind: "text",
    name: "other.tex",
    sizeBytes: 0n,
  });
  await assert.rejects(
    rpc(owner, "compareDocumentHistory", {
      nodeId: otherId,
      versionId: named.id,
    }),
    /Version not found/,
  );
  console.info("Checking large document restoration and diff fallback");
  const largeValue = "Large source\n".repeat(20_000);
  const largeSaved = z.object({ objectKey: z.string() }).parse(
    await rpc(owner, "saveProjectSource", {
      nodeId: otherId,
      content: Buffer.from(largeValue).toString("base64"),
      expectedObjectKey: null,
    }),
  );
  const largeVersion = documentVersionSchema.parse(
    await rpc(owner, "createDocumentVersion", {
      nodeId: otherId,
      label: "Large draft",
    }),
  );
  const largeHistory = pageSchema.parse(
    await rpc(owner, "listDocumentHistory", { nodeId: otherId }),
  );
  const emptyVersion = largeHistory.versions.find(
    (entry) => entry.id !== largeVersion.id,
  );
  assert(emptyVersion);
  await rpc(owner, "restoreDocumentVersion", {
    nodeId: otherId,
    versionId: emptyVersion.id,
  });
  assert.equal(
    z.object({ current: z.string() }).parse(
      await rpc(owner, "compareDocumentHistory", {
        nodeId: otherId,
        versionId: largeVersion.id,
      }),
    ).current,
    "",
  );
  await rpc(owner, "restoreDocumentVersion", {
    nodeId: otherId,
    versionId: largeVersion.id,
  });
  assert.equal(
    z.object({ current: z.string() }).parse(
      await rpc(owner, "compareDocumentHistory", {
        nodeId: otherId,
        versionId: largeVersion.id,
      }),
    ).current,
    largeValue,
  );
  assert.equal(
    await (await bucket.get(largeSaved.objectKey))?.text(),
    largeValue,
  );
  await owner.getByLabel("Document", { exact: true }).selectOption(otherId);
  await owner
    .getByText("This comparison is too large to display.", { exact: false })
    .waitFor();
  await owner
    .getByRole("button", { name: "Download current text", exact: true })
    .waitFor();
  await owner.getByLabel("Document", { exact: true }).selectOption(node.id);
  console.info("Checking durable state and independent R2 snapshots");
  const retainedObject = await bucket.get(
    `history/${projectId}/${node.id}/${named.id}.yjs`,
  );
  assert(retainedObject);
  const independent = new Y.Doc();
  Y.applyUpdate(
    independent,
    new Uint8Array(await retainedObject.arrayBuffer()),
  );
  assert.match(independent.getText("source").toString(), /Edited by Grace/);
  independent.destroy();
  await mf.unsafeEvictDurableObject(
    "document-history-test",
    "ProjectCollaboration",
    { name: projectId, webSockets: "hibernate" },
  );
  assert((await list()).versions.some((entry) => entry.id === named.id));
  await edit.click();
  await editor.keyboard.press("ControlOrMeta+End");
  await editor.keyboard.insertText("Pending at restart\n");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await eventually(
    async () =>
      (
        await storage.exec(
          "SELECT node_id FROM history_activity WHERE node_id = ?",
          node.id,
        )
      ).length === 1,
    "accepted activity before restart",
  );
  await mf.dispose();
  mf = new Miniflare({
    ...runtimeOptions(),
    port: Number(new URL(origin).port),
  });
  await mf.ready;
  bucket = await mf.getR2Bucket("SOURCES");
  storage = await mf.unsafeGetDurableObjectStorage(
    "document-history-test",
    "ProjectCollaboration",
    { name: projectId },
  );
  assert.match(
    (
      await storage.exec<{ authors: string }>(
        "SELECT authors FROM history_activity WHERE node_id = ?",
        node.id,
      )
    )[0]?.authors ?? "",
    /Grace/,
  );
  assert((await list()).versions.some((entry) => entry.id === named.id));
  await rpc(owner, "restoreDocumentVersion", { versionId: named.id });
  // Pagination must include all versions exactly once, including equal timestamps.
  storage = await mf.unsafeGetDurableObjectStorage(
    "document-history-test",
    "ProjectCollaboration",
    { name: projectId },
  );
  for (let index = 0; index < 55; index++)
    await storage.exec(
      "INSERT INTO history_versions (id, project_id, node_id, created_at, label, kind, authors) VALUES (?, ?, ?, ?, NULL, 'automatic', '[]')",
      crypto.randomUUID(),
      projectId,
      node.id,
      Date.now(),
    );
  const first = await list();
  assert.equal(first.versions.length, 50);
  assert(first.next);
  const second = pageSchema.parse(
    await rpc(owner, "listDocumentHistory", { before: first.next }),
  );
  assert.equal(second.next, null);
  const total = await storage.exec<{ count: number }>(
    "SELECT count(*) AS count FROM history_versions WHERE node_id = ?",
    node.id,
  );
  assert.equal(
    new Set([...first.versions, ...second.versions].map((entry) => entry.id))
      .size,
    total[0]?.count,
  );
  await db
    .delete(projectCollaborator)
    .where(eq(projectCollaborator.userId, editorId));
  await assert.rejects(
    rpc(editor, "compareDocumentHistory", { versionId: named.id }),
    /Project not found/,
  );
  console.info("Checking narrow layout and project deletion cleanup");
  await owner.setViewportSize({ width: 390, height: 844 });
  assert(
    await owner
      .getByRole("tabpanel", { name: "Document history", exact: true })
      .isVisible(),
  );
  await eventually(
    async () =>
      ((
        await owner
          .getByRole("tabpanel", { name: "Document history", exact: true })
          .boundingBox()
      )?.width ?? 0) > 350,
    "history uses narrow viewport width",
  );
  await owner.screenshot({ path: "/tmp/texfolia-history-mobile.png" });
  assert(
    await owner.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await db
    .update(project)
    .set({ deletedAt: new Date() })
    .where(eq(project.id, projectId));
  await assert.rejects(rpc(owner, "listDocumentHistory"), /Project not found/);
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: "17 * * * *", scheduledTime: new Date() });
  assert.equal(
    (await bucket.list({ prefix: `history/${projectId}/` })).objects.length,
    0,
  );
  assert.equal(
    (await storage.exec("SELECT id FROM history_versions")).length,
    0,
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  console.info("Document history integration passed");
} finally {
  await browser.close();
  await mf.dispose();
  if (projectId) await db.delete(project).where(eq(project.id, projectId));
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  await db.$client.end();
  await rm(directory, { recursive: true, force: true });
}
