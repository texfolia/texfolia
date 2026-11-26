import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BuildSnapshot } from "@texfolia/contracts";
import { createDb } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectCollaboration,
  projectCollaborator,
  projectNode,
  session,
  user,
} from "@texfolia/db/schema";
import { and, eq } from "drizzle-orm";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { chromium, type Page } from "playwright";
import { z } from "zod";

import { compileDeltaSchema, hashSource } from "#/lib/compile";
import { projectMetadataSchema, projectMetadataVersion } from "#/lib/projects";

import { createProject } from "../src/lib/projects/project.server";
import {
  createShareLink,
  revokeShareLink,
} from "../src/lib/sharing/project-share-links.server";
import { withBuildsFixture } from "./builds/miniflare";

declare global {
  interface Window {
    metadataSaveRpc: (input: {
      method: "POST";
      data: Record<string, unknown>;
    }) => Promise<unknown>;
    metadataRpc: (input: {
      method: "POST";
      data: { projectId: string; nodeId: string };
    }) => Promise<unknown>;
  }
}

// Run the built app: real route loaders, RPC transport, React workspace, database,
// R2 and Durable Objects. Only the compiler engine is replaced by a held job.
const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Use an isolated Postgres test database",
);
const db = createDb(connectionString);
const root = new URL("../dist/server/", import.meta.url).pathname;
const filenames = await readdir(root, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "texfolia-workspace-metadata-"));
const secret = "workspace-metadata-secret-not-for-production";
const submissions: Array<
  z.infer<typeof compileDeltaSchema> & { resync?: boolean }
> = [];
let submissionGate: Promise<void> | undefined;
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
let snapshot: BuildSnapshot = {
  revision: 0,
  current: null,
  latestBuild: null,
  stale: false,
  artifacts: null,
};
function emit() {
  const data = new TextEncoder().encode(`${JSON.stringify(snapshot)}\n`);
  for (const subscriber of subscribers) subscriber.enqueue(data);
}
const mf = new Miniflare({
  ...withBuildsFixture(
    {
      name: "workspace-metadata-test",
      modules: filenames
        .filter((path) => path.endsWith(".js"))
        .sort((a, b) =>
          a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b),
        )
        .map((path) => ({ type: "ESModule", path: join(root, path) })),
      modulesRoot: root,
      compatibilityDate: "2026-10-31",
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
      bindings: {
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: "http://localhost",
        STRIPE_SECRET_KEY: "sk_test_workspace_metadata",
        ...Object.fromEntries(
          ["GITHUB", "GOOGLE", "GITLAB", "MICROSOFT"].flatMap((provider) => [
            [`${provider}_CLIENT_ID`, "fixture"],
            [`${provider}_CLIENT_SECRET`, "fixture"],
          ]),
        ),
      },
    },
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/events")) {
        let subscription: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              subscription = controller;
              subscribers.add(controller);
              emit();
            },
            cancel() {
              subscribers.delete(subscription);
            },
          }),
        );
      }
      if (url.pathname.endsWith("/changed")) {
        snapshot = { ...snapshot, stale: true };
        emit();
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/compile")) {
        submissions.push(
          compileDeltaSchema
            .extend({ resync: z.boolean().optional() })
            .parse(await request.json()),
        );
        const id = request.headers.get("X-Compilation-Id");
        assert(id);
        const revision = snapshot.revision + 1;
        snapshot = {
          ...snapshot,
          revision,
          current: { id, revision, status: "running" },
          stale: false,
        };
        emit();
        await submissionGate;
        return Response.json(
          {
            id,
            revision,
            sourceRevision: submissions.length,
            createdAt: new Date().toISOString(),
            status: "running",
          },
          { status: 202 },
        );
      }
      if (url.pathname.endsWith("/pdf"))
        return new Response(null, { status: 404 });
      if (url.pathname.includes("/jobs/")) {
        const id = url.pathname.split("/").at(-1);
        return Response.json({
          id,
          revision: snapshot.current?.revision ?? snapshot.revision,
          createdAt: new Date().toISOString(),
          status: snapshot.current?.status ?? "running",
          error: "Fixture compile finished",
          log: "",
        });
      }
      return Response.json(snapshot);
    },
  ),
  resourcePersistencePath: directory,
});
const browser = await chromium.launch({ headless: true });
const ownerId = crypto.randomUUID();
const editorId = crypto.randomUUID();
const organizationId = crypto.randomUUID();
const errors: string[] = [];
const cookies = new Map<string, string>();
let projectId = "";
async function eventually(
  check: () => Promise<boolean> | boolean,
  label: string,
) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await Bun.sleep(50);
  }
}
async function fileMenu(page: Page, item: string) {
  await page
    .locator('[data-slot="menubar-trigger"]')
    .filter({ hasText: /^File$/ })
    .click();
  await page.getByRole("menuitem", { name: item, exact: true }).focus();
  await page.keyboard.press("Enter");
}
async function createFile(
  page: Page,
  name: string,
  kind: "file" | "folder" = "file",
) {
  const title = kind === "file" ? "New file" : "New folder";
  await fileMenu(page, title);
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog
    .getByLabel(kind === "file" ? "File name" : "Folder name", { exact: true })
    .fill(name);
  await dialog
    .getByRole("button", {
      name: kind === "file" ? "Create file" : "Create folder",
      exact: true,
    })
    .click();
  await dialog.waitFor({ state: "hidden" });
}
try {
  const origin = (await mf.ready).origin;
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const resolverFile = filenames.find(
    (name) =>
      name.includes("tanstack-start-server-fn-resolver") &&
      name.endsWith(".js"),
  );
  assert(resolverFile);
  const resolver = await readFile(join(root, resolverFile), "utf8");
  const deleteId = resolver.match(
    /"([a-f0-9]+)":\s*\{\s*functionName: "deleteProjectNode_createServerFn_handler"/,
  )?.[1];
  assert(deleteId);
  const createId = resolver.match(
    /"([a-f0-9]+)":\s*\{\s*functionName: "createProjectNode_createServerFn_handler"/,
  )?.[1];
  assert(createId);
  const saveId = resolver.match(
    /"([a-f0-9]+)":\s*\{\s*functionName: "saveProjectSource_createServerFn_handler"/,
  )?.[1];
  assert(saveId);
  const rpcBuild = await build({
    stdin: {
      contents: `import { createClientRpc } from "@tanstack/react-start/client-rpc"; window.metadataRpc = createClientRpc("${deleteId}"); window.metadataSaveRpc = createClientRpc("${saveId}");`,
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
          // Select the client half of Start's isomorphic helper, as Vite does.
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
  for (const id of [ownerId, editorId]) {
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
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const signature = createHmac("sha256", secret)
      .update(token)
      .digest("base64");
    cookies.set(id, encodeURIComponent(`${token}.${signature}`));
  }
  const created = await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: "Metadata integration" },
  });
  projectId = created.id;
  await db
    .insert(projectCollaborator)
    .values({ projectId, userId: editorId, role: "editor" });
  const main = await db.query.projectNode.findFirst({
    where: { projectId, name: "main.tex" },
  });
  assert(main);
  const bucket = await mf.getR2Bucket("SOURCES");
  const bytes = new TextEncoder().encode("Initial source\n");
  const key = `projects/${projectId}/sources/${await hashSource(bytes)}`;
  await bucket.put(key, bytes);
  await db
    .update(projectNode)
    .set({ objectKey: key, sizeBytes: BigInt(bytes.length) })
    .where(eq(projectNode.id, main.id));
  const contexts = await Promise.all(
    [ownerId, editorId].map(async (id) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        acceptDownloads: true,
      });
      await context.addCookies([
        {
          name: "better-auth.session_token",
          value: cookies.get(id) ?? "",
          url: origin,
        },
      ]);
      return context;
    }),
  );
  const [ownerContext, editorContext] = contexts;
  assert(ownerContext && editorContext);
  const owner = await ownerContext.newPage();
  const editor = await editorContext.newPage();
  for (const page of [owner, editor]) {
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error);
    });
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /content security policy/i.test(message.text())
      )
        errors.push(message.text());
    });
    await page.goto(`${origin}/project/${projectId}`);
    await page.locator('.cm-content[contenteditable="true"]').waitFor();
  }
  const activeEditor = editor
    .locator('.cm-content[contenteditable="true"]')
    .first();
  await activeEditor.click();
  await editor.keyboard.press("ControlOrMeta+End");
  await editor.keyboard.insertText("Unsaved draft\n");
  await editor.keyboard.press("Shift+ArrowLeft");
  const selection = await editor.evaluate(() =>
    window.getSelection()?.toString(),
  );
  console.info("Checking remote creation preserves editor and selection");
  const captured = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await owner.route(
    `**/api/projects/${projectId}/metadata`,
    async (route) => {
      const response = await route.fetch();
      captured.resolve();
      await release.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await captured.promise;
  await createFile(owner, "chapter.tex");
  release.resolve();
  await editor
    .getByRole("button", { name: "chapter.tex", exact: true })
    .waitFor();
  assert.equal(await editor.getByRole("tab", { name: /main.tex/ }).count(), 1);
  assert.equal(
    await editor.evaluate(() => window.getSelection()?.toString()),
    selection,
  );
  assert.match(await activeEditor.innerText(), /Unsaved draft/);
  await editor
    .getByRole("button", { name: "chapter.tex", exact: true })
    .dblclick();
  await editor.getByRole("tab", { name: "chapter.tex", exact: true }).waitFor();
  // Losing an RPC acknowledgement after commit must reconcile the created file,
  // rather than retiring its collaborative document as a failed optimistic row.
  await owner.route(
    `**/_serverFn/${createId}`,
    async (route) => {
      await route.fetch();
      await route.abort();
    },
    { times: 1 },
  );
  await fileMenu(owner, "New file");
  await owner
    .getByLabel("File name", { exact: true })
    .fill("lost-response.tex");
  await owner.getByRole("button", { name: "Create file", exact: true }).click();
  await owner
    .getByRole("alert")
    .filter({ hasText: "Could not create this item" })
    .waitFor();
  await owner.getByRole("button", { name: "Cancel", exact: true }).click();
  await owner
    .getByRole("button", { name: "lost-response.tex", exact: true })
    .dblclick();
  await owner
    .getByRole("tab", { name: "lost-response.tex", exact: true })
    .waitFor();
  assert.equal(
    await owner
      .getByText(
        "This file was deleted. Your local text is still available to copy.",
      )
      .count(),
    0,
  );
  await createFile(owner, "chapters", "folder");
  await editor.getByRole("button", { name: "chapters", exact: true }).waitFor();
  await owner.getByLabel("Upload project source").setInputFiles({
    name: "asset.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0, 255, 17, 23]),
  });
  await editor
    .getByRole("button", { name: "asset.bin", exact: true })
    .waitFor();
  const asset = await db.query.projectNode.findFirst({
    where: { projectId, name: "asset.bin" },
  });
  assert(asset);
  await owner.evaluate((content) => {
    const nonce = document
      .querySelector('meta[property="csp-nonce"]')
      ?.getAttribute("content");
    if (!nonce)
      throw new Error("Missing document CSP nonce for the RPC fixture");
    const script = document.createElement("script");
    script.nonce = nonce;
    script.textContent = content;
    document.head.appendChild(script);
  }, rpcScript);
  await owner.evaluate(
    (data) => window.metadataSaveRpc({ method: "POST", data }),
    {
      projectId,
      nodeId: asset.id,
      expectedObjectKey: asset.objectKey,
      content: Buffer.from([0, 255, 17, 23, 42]).toString("base64"),
    },
  );
  console.info("Checking compilation and changes during an active job");
  const accepted = Promise.withResolvers<void>();
  submissionGate = accepted.promise;
  const before = submissions.length;
  await editor.getByRole("button", { name: /^Compile status:/ }).click();
  await eventually(
    () => submissions.length > before,
    "Compile did not reach authenticated route",
  );
  // Nothing locks the project while the compiler request is unacknowledged, so
  // the write completes. The route then finds that the sources changed.
  await createFile(owner, "acceptance.tex");
  accepted.resolve();
  submissionGate = undefined;
  assert(!("acceptance.tex" in (submissions.at(-1)?.files ?? {})));
  assert("chapter.tex" in (submissions.at(-1)?.files ?? {}));
  assert("asset.bin" in (submissions.at(-1)?.files ?? {}));
  assert.equal(
    submissions.at(-1)?.resync,
    false,
    "Refreshed client should retain hash-only delta transport",
  );
  const assetVersion = await db.query.projectNode.findFirst({
    where: { id: asset.id },
  });
  assert(assetVersion?.objectKey);
  assert.equal(
    submissions.at(-1)?.files["asset.bin"]?.hash,
    assetVersion.objectKey.split("/").at(-1),
  );
  const version = await db.query.projectNode.findFirst({
    where: { id: main.id },
  });
  assert(version?.objectKey);
  const savedResponse = await editorContext.request.get(
    `${origin}/api/projects/${projectId}/metadata`,
  );
  const savedMetadata = projectMetadataSchema.parse(await savedResponse.json());
  assert.equal(
    savedMetadata.sourceVersions[main.id]?.objectKey,
    version.objectKey,
  );
  const staleMetadata = savedMetadata;
  await createFile(owner, "during.tex");
  await editor
    .getByRole("button", { name: "during.tex", exact: true })
    .waitFor();
  const chapter = await db.query.projectNode.findFirst({
    where: { projectId, name: "chapter.tex" },
  });
  assert(chapter);
  await owner.evaluate(
    ({ projectId, nodeId }) =>
      window.metadataRpc({ method: "POST", data: { projectId, nodeId } }),
    { projectId, nodeId: chapter.id },
  );
  await editor
    .getByRole("button", { name: "chapter.tex", exact: true })
    .waitFor({ state: "detached" });
  await editor
    .getByText(
      "This file was deleted. Your local text is still available to copy.",
    )
    .waitFor();
  assert.equal(
    await editor.getByRole("tab", { name: /chapter.tex/ }).count(),
    1,
  );
  // A stale client that bypasses preflight still cannot omit a new source or
  // resurrect a deleted one through the authenticated compile route.
  const staleCompile = await ownerContext.request.post(
    `${origin}/api/compile/${projectId}`,
    {
      headers: {
        "X-Compilation-Id": crypto.randomUUID(),
        "X-Source-Metadata": await projectMetadataVersion(staleMetadata),
      },
      data: {
        mainFile: "main.tex",
        baseRevision: 0,
        revision: 1,
        files: {},
        deleted: ["during.tex"],
      },
    },
  );
  assert.equal(staleCompile.status(), 202);
  const canonical = submissions.at(-1);
  assert(canonical?.resync);
  assert("during.tex" in canonical.files);
  assert(!("chapter.tex" in canonical.files));
  snapshot = {
    ...snapshot,
    current: snapshot.current
      ? { ...snapshot.current, status: "failed" }
      : null,
  };
  emit();
  console.info("Checking live connections open without a cached session");
  // Only the session token: reading it refreshes the cached session, and a
  // WebSocket upgrade cannot carry that cookie.
  for (const path of [
    `/api/collaboration/${projectId}/${main.id}`,
    `/api/compile/${projectId}?events=1`,
  ]) {
    // Bun's WebSocket takes headers, which the DOM types do not have.
    const socket = Reflect.construct(WebSocket, [
      new URL(path, origin.replace(/^http/, "ws")),
      {
        headers: {
          Cookie: `better-auth.session_token=${cookies.get(editorId)}`,
          Origin: origin,
        },
      },
    ]) as WebSocket;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
    socket.addEventListener("close", reject);
    await promise.catch(() => assert.fail(`${path} did not connect`));
    socket.close();
  }
  console.info("Checking unchanged metadata is not sent again");
  const unchanged = await editor.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/projects/${projectId}/metadata`) &&
      response.status() === 304,
  );
  assert.equal((await unchanged.allHeaders())["cache-control"], "no-store");
  console.info(
    "Checking a hidden tab pauses polling and catches up when shown",
  );
  const setVisibility = (state: "hidden" | "visible") =>
    editor.evaluate((state) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
  await setVisibility("hidden");
  // Lets a request that was already running finish.
  await editor.waitForTimeout(1_000);
  let hiddenRequests = 0;
  const countRequest = (request: { url: () => string }) => {
    if (request.url().endsWith("/metadata")) hiddenRequests++;
  };
  editor.on("request", countRequest);
  await createFile(owner, "while-hidden.tex");
  await editor.waitForTimeout(5_000);
  assert.equal(hiddenRequests, 0, "A hidden tab does not poll");
  editor.off("request", countRequest);
  await setVisibility("visible");
  await editor
    .getByRole("button", { name: "while-hidden.tex", exact: true })
    .waitFor();
  console.info("Checking export refreshes a paused metadata session");
  await editor.route(`**/api/projects/${projectId}/metadata`, (route) =>
    route.abort(),
  );
  await createFile(owner, "export.tex");
  await editor.unroute(`**/api/projects/${projectId}/metadata`);
  await fileMenu(editor, "Export project");
  const exportDialog = editor.getByRole("dialog", {
    name: "Export project",
    exact: true,
  });
  const downloading = editor.waitForEvent("download");
  await exportDialog.getByRole("button", { name: "Download zip" }).click();
  const download = await downloading;
  const downloadPath = await download.path();
  assert(downloadPath);
  const zip = await readFile(downloadPath);
  assert(zip.includes(Buffer.from("export.tex")));
  assert(zip.includes(Buffer.from("during.tex")));
  assert(!zip.includes(Buffer.from("chapter.tex")));
  assert(zip.includes(Buffer.from([0, 255, 17, 23, 42])));
  assert(zip.includes(Buffer.from("Unsaved draft")));
  await editor.keyboard.press("Escape");
  await exportDialog.waitFor({ state: "hidden" });
  console.info(
    "Checking offline recovery across metadata reconciliation and reload",
  );
  await editor.getByRole("tab", { name: /main.tex/ }).click();
  await editorContext.setOffline(true);
  await editor
    .getByText("Offline. Edits will merge when reconnected.")
    .first()
    .waitFor();
  await activeEditor.click();
  await editor.keyboard.press("ControlOrMeta+End");
  await editor.keyboard.insertText("Offline recovery marker\n");
  await createFile(owner, "offline.tex");
  await editorContext.setOffline(false);
  await editor
    .getByRole("button", { name: "offline.tex", exact: true })
    .waitFor();
  assert.match(await activeEditor.innerText(), /Offline recovery marker/);
  await editor.reload();
  await editor.locator('.cm-content[contenteditable="true"]').first().waitFor();
  await eventually(
    async () =>
      (await editor.locator(".cm-content").first().innerText()).includes(
        "Offline recovery marker",
      ),
    "Offline edit disappeared after reload",
  );
  console.info(
    "Checking personal access revocation and organization membership",
  );
  const activeCompile = submissions.length;
  await editor.getByRole("button", { name: /^Compile status:/ }).click();
  await eventually(
    () => submissions.length > activeCompile,
    "Compile before revocation did not start",
  );
  const headers = {
    Cookie: `better-auth.session_token=${cookies.get(editorId)}`,
  };
  await db
    .delete(projectCollaborator)
    .where(
      and(
        eq(projectCollaborator.projectId, projectId),
        eq(projectCollaborator.userId, editorId),
      ),
    );
  await editor
    .getByRole("alert")
    .filter({ hasText: "Project access is no longer available" })
    .waitFor();
  assert.equal(
    (await fetch(`${origin}/api/projects/${projectId}/metadata`, { headers }))
      .status,
    404,
  );
  assert.equal(
    (await fetch(`${origin}/api/projects/${projectId}/metadata`)).status,
    401,
  );
  await createFile(owner, "secret.tex");
  assert.equal(
    await editor
      .getByRole("button", { name: "secret.tex", exact: true })
      .count(),
    0,
  );
  assert.match(
    await editor.locator(".cm-content").first().innerText(),
    /Offline recovery marker/,
  );

  // Unified /project/$projectId share-link entry: redeem-and-redirect without
  // leaving the token in the URL, lightweight guest bundle for view links,
  // sign-in gate for edit/comment links, and immediate revocation.
  console.info(
    "Checking unified share-link redirect, guest shell, and revocation",
  );
  const viewLink = await createShareLink({
    db,
    userId: ownerId,
    data: { projectId, role: "viewer" },
  });
  const editLink = await createShareLink({
    db,
    userId: ownerId,
    data: { projectId, role: "editor" },
  });
  const viewRedirect = await fetch(`${origin}/share/${viewLink.token}`, {
    redirect: "manual",
  });
  assert.equal(viewRedirect.status, 303);
  assert.equal(viewRedirect.headers.get("location"), `/project/${projectId}`);
  assert.equal(viewRedirect.headers.get("referrer-policy"), "no-referrer");
  assert.match(viewRedirect.headers.get("set-cookie") ?? "", /HttpOnly/i);
  const editRedirect = await fetch(`${origin}/share/${editLink.token}`, {
    redirect: "manual",
  });
  assert.equal(editRedirect.status, 303);
  assert.equal(
    editRedirect.headers.get("location"),
    `/login?redirectTo=${encodeURIComponent(`/project/${projectId}`)}`,
  );

  const guestContext = await browser.newContext();
  const guestScripts: string[] = [];
  const guest = await guestContext.newPage();
  guest.setDefaultTimeout(20_000);
  guest.on("pageerror", (error) => errors.push(error.message));
  guest.on("request", (request) => {
    if (request.resourceType() === "script") guestScripts.push(request.url());
  });
  await guest.goto(`${origin}/share/${viewLink.token}`);
  await guest.waitForURL(`${origin}/project/${projectId}`);
  await guest.getByText("View only", { exact: true }).waitFor();
  assert(
    !guestScripts.some((url) => url.includes("member-workspace")),
    `Anonymous guest downloaded the member workspace bundle: ${guestScripts.join(", ")}`,
  );

  // Signed-in user with no access redeems an edit link onto their account.
  await editor.goto(`${origin}/share/${editLink.token}`);
  await editor.waitForURL(`${origin}/project/${projectId}`);
  await editor.locator('.cm-content[contenteditable="true"]').waitFor();

  await revokeShareLink({
    db,
    userId: ownerId,
    data: { projectId, linkId: viewLink.id },
  });
  await revokeShareLink({
    db,
    userId: ownerId,
    data: { projectId, linkId: editLink.id },
  });
  await guest.reload();
  await guest
    .getByRole("heading", { name: "This link no longer works" })
    .waitFor();
  await guest.goto(`${origin}/share/${viewLink.token}`);
  await guest
    .getByRole("heading", { name: "This link no longer works" })
    .waitFor();
  await editor.reload();
  await editor.getByRole("heading", { name: "Project not found" }).waitFor();
  await guestContext.close();

  await db.insert(organization).values({
    id: organizationId,
    name: "Metadata organization",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId,
    userId: editorId,
    role: "member",
    createdAt: new Date(),
  });
  await db
    .update(project)
    .set({ organizationId, ownerId: null })
    .where(eq(project.id, projectId));
  assert.equal(
    (await fetch(`${origin}/api/projects/${projectId}/metadata`, { headers }))
      .status,
    200,
  );
  await db.delete(member).where(eq(member.organizationId, organizationId));
  assert.equal(
    (await fetch(`${origin}/api/projects/${projectId}/metadata`, { headers }))
      .status,
    404,
  );
  assert.deepEqual(errors, []);
  console.info(
    "Authenticated two-session workspace metadata integration passed",
  );
} finally {
  await browser.close();
  await mf.dispose();
  if (projectId) {
    await db.delete(project).where(eq(project.id, projectId));
    // Room registrations survive project cascades. This fixture discards its
    // Durable Object storage, so its registration must be removed explicitly.
    await db
      .delete(projectCollaboration)
      .where(eq(projectCollaboration.projectId, projectId));
  }
  await db.delete(organization).where(eq(organization.id, organizationId));
  for (const id of [ownerId, editorId])
    await db.delete(user).where(eq(user.id, id));
  await db.$client.end();
  await rm(directory, { recursive: true, force: true });
}
