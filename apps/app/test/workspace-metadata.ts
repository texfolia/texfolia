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
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { chromium, type Page } from "playwright";
import { z } from "zod";

import { compileDeltaSchema, hashSource } from "#/features/compile";
import {
  projectMetadataSchema,
  projectMetadataVersion,
} from "#/features/projects";

import { createProject } from "../src/features/projects/project.server";

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
  const data = new TextEncoder().encode(
    `data: ${JSON.stringify(snapshot)}\n\n`,
  );
  for (const subscriber of subscribers) subscriber.enqueue(data);
}
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    name: "workspace-metadata-test",
    modules: filenames
      .filter((path) => path.endsWith(".js"))
      .sort((a, b) =>
        a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b),
      )
      .map((path) => ({ type: "ESModule", path: join(root, path) })),
    modulesRoot: root,
    compatibilityDate: "2026-10-30",
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
    serviceBindings: {
      COMPILER: async (request) => {
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
            { headers: { "Content-Type": "text/event-stream" } },
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
    },
  }),
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
  await editor
    .getByRole("button", { name: "Compile status", exact: true })
    .click();
  await eventually(
    () => submissions.length > before,
    "Compile did not reach authenticated route",
  );
  const creatingDuringAcceptance = createFile(owner, "acceptance.tex");
  // The real mutation must be waiting on the project's row lock while the
  // compiler request is unacknowledged; metadata cannot slip through this gap.
  await eventually(async () => {
    const result = await db.$client.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%for update%' LIMIT 1",
    );
    return result.rows.length > 0;
  }, "Metadata write did not wait for compile acceptance");
  accepted.resolve();
  submissionGate = undefined;
  await creatingDuringAcceptance;
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
  const savedResponse = await editor.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/projects/${projectId}/metadata`) &&
      response.status() === 200,
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
  await editor
    .getByRole("button", { name: "Compile status", exact: true })
    .click();
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
