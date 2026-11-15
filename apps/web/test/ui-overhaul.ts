import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@texfolia/db";
import {
  invitation,
  member,
  organization,
  projectNode,
  session,
  template,
  user,
} from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { chromium, type Page } from "playwright";

import { lockProject } from "../src/lib/project-access.server";
import {
  grantProjectAccess,
  revokeProjectAccess,
} from "../src/lib/project-sharing.server";
import { createProject } from "../src/lib/project.server";

const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Use an isolated Postgres test database",
);
const db = createDb(connectionString);
const root = new URL("../dist/server/", import.meta.url).pathname;
const filenames = await readdir(root, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "texfolia-ui-"));
const screenshots = new URL("../../../.audit/nat-286/", import.meta.url)
  .pathname;
await mkdir(screenshots, { recursive: true });
const secret = "ui-overhaul-test-secret-not-for-production";
const ownerId = crypto.randomUUID();
const readerId = crypto.randomUUID();
const organizationId = crypto.randomUUID();
const invitationId = crypto.randomUUID();
const templateId = crypto.randomUUID();
const portReservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = portReservation.port;
portReservation.stop(true);
assert(port);
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    name: "ui-overhaul-test",
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
    bindings: {
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      STRIPE_SECRET_KEY: "sk_test_ui",
      TEMPLATE_REVIEWER_IDS: ownerId,
      ...Object.fromEntries(
        ["GITHUB", "GOOGLE", "GITLAB", "MICROSOFT"].flatMap((provider) => [
          [`${provider}_CLIENT_ID`, "fixture"],
          [`${provider}_CLIENT_SECRET`, "fixture"],
        ]),
      ),
    },
    serviceBindings: {
      COMPILER: async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/pdf")) return new Response(null, { status: 404 });
        if (path.endsWith("/changed"))
          return new Response(null, { status: 204 });
        const snapshot = {
          revision: 0,
          current: null,
          latestBuild: null,
          stale: false,
          artifacts: null,
        };
        if (path.endsWith("/events"))
          return new Response(`data: ${JSON.stringify(snapshot)}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        return Response.json(snapshot);
      },
    },
  }),
  port,
  resourcePersistencePath: directory,
});
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
function monitor(page: Page) {
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|hydrated|React error/i.test(message.text())
    )
      errors.push(message.text());
  });
}
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: join(screenshots, `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    `${name} must not overflow horizontally`,
  );
}
async function eventually(check: () => Promise<boolean>, label: string) {
  const until = Date.now() + 20_000;
  while (!(await check())) {
    assert(Date.now() < until, label);
    await Bun.sleep(100);
  }
}
try {
  const origin = (await mf.ready).origin;
  assert.equal(
    origin,
    `http://127.0.0.1:${port}`,
    "Auth origin must match the test server",
  );
  for (const { id, name } of [
    { id: ownerId, name: "Ada Writer" },
    { id: readerId, name: "Emmy Reader" },
  ]) {
    await db.insert(user).values({
      id,
      name,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  const project = await createProject({
    db,
    ownerId,
    data: { id: crypto.randomUUID(), name: "A study of small things" },
  });
  const nodes = await db.query.projectNode.findMany({
    where: { projectId: project.id },
  });
  const rootNode = nodes.find((node) => node.parentId === null);
  assert(rootNode);
  await db.insert(projectNode).values({
    projectId: project.id,
    parentId: rootNode.id,
    name: "notes.tex",
    kind: "text",
    sizeBytes: 0n,
  });
  const folderId = crypto.randomUUID();
  await db.insert(projectNode).values({
    id: folderId,
    projectId: project.id,
    parentId: rootNode.id,
    name: "chapters",
    kind: "folder",
    sizeBytes: 0n,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: "Research group",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId,
    userId: readerId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(invitation).values({
    id: invitationId,
    organizationId,
    inviterId: readerId,
    email: `${ownerId}@example.com`,
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() + 86400_000),
    createdAt: new Date(),
  });
  await db.insert(template).values({
    id: templateId,
    ownerId: readerId,
    publisherName: "Emmy Reader",
    title: "A simple article",
    description: "A short article with room for your next idea.",
    tags: ["article", "research"],
    license: "CC0-1.0",
    mainFile: "main.tex",
    status: "approved",
    visibility: "public",
    snapshot: [
      {
        id: rootNode.id,
        parentId: null,
        name: "Article",
        kind: "folder",
        objectKey: null,
        sizeBytes: 0,
      },
      {
        id: crypto.randomUUID(),
        parentId: rootNode.id,
        name: "main.tex",
        kind: "text",
        objectKey: null,
        sizeBytes: 0,
      },
    ],
    previewStatus: "failed",
  });
  async function newSession(userId: string) {
    const token = crypto.randomUUID();
    await db.insert(session).values({
      id: crypto.randomUUID(),
      token,
      userId,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const signature = createHmac("sha256", secret)
      .update(token)
      .digest("base64");
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: encodeURIComponent(`${token}.${signature}`),
        url: origin,
      },
    ]);
    const page = await context.newPage();
    monitor(page);
    return page;
  }
  const publicContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const publicPage = await publicContext.newPage();
  monitor(publicPage);
  await publicPage.route("https://challenges.cloudflare.com/**", (route) =>
    route.abort(),
  );
  for (const width of [1440, 768, 375, 320]) {
    await publicPage.setViewportSize({ width, height: 1000 });
    for (const [path, heading, name] of [
      ["/", "Good ideas", "landing"],
      ["/pricing", "Space to do your best work", "pricing"],
      ["/privacy", "Privacy", "privacy"],
      ["/terms", "Terms of service", "terms"],
      ["/templates", "A starting point", "templates"],
      [`/template/${templateId}`, "A simple article", "template"],
      ["/login", "Sign in to Texfolia", "login"],
    ]) {
      await publicPage.goto(`${origin}${path}`);
      await publicPage
        .getByRole("heading", { level: 1 })
        .filter({ hasText: heading })
        .waitFor();
      await capture(publicPage, `${name}-${width}`);
    }
  }
  await publicPage.goto(origin);
  const navigation = publicPage.getByRole("navigation", {
    name: "Main navigation",
  });
  assert.deepEqual(await navigation.getByRole("link").allTextContents(), [
    "Templates",
    "Pricing",
  ]);
  assert.doesNotMatch(await publicPage.locator("main").innerText(), /\bgit\b/i);
  await navigation
    .getByRole("link", { name: "Templates", exact: true })
    .focus();
  await publicPage.keyboard.press("Enter");
  await publicPage.waitForURL(/\/templates/);
  await navigation.getByRole("link", { name: "Pricing", exact: true }).focus();
  await publicPage.keyboard.press("Enter");
  await publicPage.waitForURL(/\/pricing/);
  console.info(
    "Public routes fit desktop, tablet, and narrow mobile viewports",
  );
  const owner = await newSession(ownerId);
  const reader = await newSession(readerId);
  await owner.goto(`${origin}/projects`);
  await owner.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await capture(owner, "projects-desktop");
  assert.equal(
    await owner.getByRole("checkbox").count(),
    0,
    "No inert bulk selection",
  );
  const projectRow = owner.getByRole("row").filter({
    has: owner.getByRole("link", { name: project.name, exact: true }),
  });
  await projectRow
    .getByRole("cell", { name: "Personal", exact: true })
    .waitFor();
  assert.equal(await projectRow.locator("img").count(), 0, "No demo avatars");
  assert.equal(await projectRow.getByRole("button").count(), 1);
  await projectRow
    .getByRole("button", { name: `Delete ${project.name}`, exact: true })
    .waitFor();
  await owner
    .getByRole("link", { name: `Open ${project.name}`, exact: true })
    .focus();
  await owner.keyboard.press("Enter");
  await owner.locator('.cm-content[contenteditable="true"]').waitFor();
  await owner.getByRole("form", { name: "Share project" }).waitFor();
  await owner
    .getByText("Only the owner has access.", { exact: true })
    .waitFor();
  const geometry = await owner.evaluate(() => {
    const sidebar = document.querySelector(
      '[data-slot="sidebar-container"][data-side="right"]',
    );
    const editor = document.querySelector(".cm-editor");
    const row = document.querySelector(
      '[aria-label="Project files"] [data-slot="sidebar-menu-button"]',
    );
    if (!sidebar || !editor || !row)
      throw new Error("Workspace layout missing");
    return {
      sidebarX: sidebar.getBoundingClientRect().x,
      editorX: editor.getBoundingClientRect().x,
      rowRadius: getComputedStyle(row).borderRadius,
      rowHeight: row.getBoundingClientRect().height,
    };
  });
  assert(geometry.sidebarX > geometry.editorX);
  assert.equal(
    geometry.rowRadius,
    "0px",
    "File rows use the square editor style",
  );
  assert.equal(geometry.rowHeight, 28);
  assert.equal(
    await owner
      .getByRole("link", { name: "Back to Projects", exact: true })
      .evaluate((link) => getComputedStyle(link).borderRadius),
    "0px",
    "Link buttons also use the square editor style",
  );
  await capture(owner, "workspace-desktop");
  await owner
    .getByRole("button", { name: "Close PDF Preview", exact: true })
    .click();
  await owner.getByRole("button", { name: "PDF preview", exact: true }).click();
  await owner.getByRole("tab", { name: "PDF Preview", exact: true }).waitFor();
  const share = owner.getByRole("form", { name: "Share project" });
  await share.getByRole("textbox").fill(`${crypto.randomUUID()}@example.com`);
  await share.getByRole("button", { name: "Share", exact: true }).click();
  await owner
    .getByRole("alert")
    .filter({ hasText: "No Texfolia account" })
    .waitFor();
  await share.getByRole("textbox").fill(`${readerId}@example.com`);
  await share.getByRole("button", { name: "Share", exact: true }).click();
  await owner
    .getByRole("button", { name: "Remove Emmy Reader", exact: true })
    .waitFor();
  await reader.goto(`${origin}/projects`);
  const sharedRow = reader.getByRole("row").filter({
    has: reader.getByRole("link", { name: project.name, exact: true }),
  });
  await sharedRow
    .getByRole("cell", { name: "1 collaborator", exact: true })
    .waitFor();
  assert.equal(await sharedRow.getByRole("button").count(), 0);
  await sharedRow
    .getByRole("link", { name: project.name, exact: true })
    .focus();
  await reader.keyboard.press("Enter");
  await reader.locator('.cm-content[contenteditable="false"]').waitFor();
  assert.equal(
    await reader.getByRole("button", { name: /^Manage / }).count(),
    0,
  );
  assert.equal(
    await reader.getByRole("button", { name: "New file", exact: true }).count(),
    0,
  );
  assert.equal(
    await reader.getByRole("form", { name: "Share project" }).count(),
    0,
  );
  await assert.rejects(
    grantProjectAccess({
      db,
      userId: readerId,
      data: {
        projectId: project.id,
        email: `${ownerId}@example.com`,
        role: "editor",
      },
    }),
  );
  await assert.rejects(
    revokeProjectAccess({
      db,
      userId: readerId,
      data: { projectId: project.id, userId: ownerId },
    }),
  );
  await share.getByRole("textbox").fill(`${readerId}@example.com`);
  await share.getByRole("combobox").selectOption("editor");
  await share.getByRole("button", { name: "Share", exact: true }).click();
  await reader.locator('.cm-content[contenteditable="true"]').waitFor();
  await reader
    .getByRole("button", { name: "Manage notes.tex", exact: true })
    .waitFor();
  await share.getByRole("textbox").fill(`${readerId}@example.com`);
  await share.getByRole("combobox").selectOption("viewer");
  await share.getByRole("button", { name: "Share", exact: true }).click();
  await reader.locator('.cm-content[contenteditable="false"]').waitFor();
  await reader
    .getByRole("button", { name: "Manage notes.tex", exact: true })
    .waitFor({ state: "detached" });
  await owner
    .getByRole("button", { name: "Remove Emmy Reader", exact: true })
    .focus();
  await owner.keyboard.press("Enter");
  await eventually(
    async () =>
      !(await owner
        .getByRole("button", { name: "Remove Emmy Reader", exact: true })
        .count()),
    "Collaborator removed",
  );
  await reader
    .getByRole("alert")
    .filter({ hasText: "access is no longer available" })
    .waitFor();
  await assert.rejects(
    db.transaction((tx) =>
      lockProject({
        tx,
        projectId: project.id,
        userId: readerId,
        access: "read",
      }),
    ),
  );
  await reader.goto(`${origin}/projects`);
  await reader.getByText("No projects yet", { exact: true }).waitFor();
  await owner.goto(`${origin}/projects`);
  await projectRow
    .getByRole("cell", { name: "Personal", exact: true })
    .waitFor();
  await projectRow
    .getByRole("link", { name: project.name, exact: true })
    .click();
  await owner.locator('.cm-content[contenteditable="true"]').waitFor();
  console.info(
    "Real viewer/editor grants, role changes, authorization, and live revocation passed",
  );
  await owner
    .getByRole("button", { name: "Manage notes.tex", exact: true })
    .focus();
  await owner.keyboard.press("Enter");
  await owner.getByRole("dialog").waitFor();
  await owner.keyboard.press("Escape");
  await owner.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(
    await owner
      .getByRole("button", { name: "Manage notes.tex", exact: true })
      .evaluate((button) => button === document.activeElement),
    true,
    "Closing management returns keyboard focus to the file action",
  );
  await owner.keyboard.press("Enter");
  await owner
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("appendix.tex");
  await owner
    .getByRole("dialog")
    .getByLabel("Folder", { exact: true })
    .selectOption(folderId);
  await owner
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Manage appendix.tex", exact: true })
    .waitFor();
  assert(
    await db.query.projectNode.findFirst({
      where: {
        projectId: project.id,
        name: "appendix.tex",
        parentId: folderId,
        deletedAt: { isNull: true },
      },
    }),
  );
  const editor = owner.locator('.cm-content[contenteditable="true"]');
  await editor.focus();
  await owner.keyboard.press("ControlOrMeta+End");
  await owner.keyboard.press("Enter");
  const exportMarker = "% NAT-298 export verification";
  await owner.keyboard.insertText(exportMarker);
  await owner.getByText("Export project", { exact: true }).focus();
  await owner.keyboard.press("Enter");
  assert.equal(
    await owner
      .getByRole("checkbox", { name: "Include generated out/ files" })
      .isDisabled(),
    true,
    "Generated files cannot be requested before a build exists",
  );
  const downloadReady = owner.waitForEvent("download");
  await owner
    .getByRole("button", { name: "Download zip", exact: true })
    .focus();
  await owner.keyboard.press("Enter");
  const download = await downloadReady;
  assert.equal(download.suggestedFilename(), `${project.name}.zip`);
  const zipPath = join(directory, "project.zip");
  await download.saveAs(zipPath);
  const listing = Bun.spawnSync(["unzip", "-Z1", zipPath]);
  assert.equal(listing.exitCode, 0);
  assert.deepEqual(listing.stdout.toString().trim().split("\n").sort(), [
    "chapters/appendix.tex",
    "main.tex",
  ]);
  const mainSource = Bun.spawnSync(["unzip", "-p", zipPath, "main.tex"]);
  assert.equal(mainSource.exitCode, 0);
  assert(
    mainSource.stdout.toString().includes(exportMarker),
    "Export contains current editor content",
  );
  await owner.getByRole("button", { name: "Save", exact: true }).focus();
  await owner.keyboard.press("Enter");
  await owner.getByRole("tab", { name: "main.tex", exact: true }).waitFor();
  console.info(
    "Keyboard project navigation, file dialog focus, and source ZIP download passed",
  );
  await owner
    .getByRole("button", { name: "Manage appendix.tex", exact: true })
    .click();
  await owner.getByRole("button", { name: "Delete…", exact: true }).click();
  await owner
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await eventually(
    async () =>
      !(await owner
        .getByRole("button", { name: "Manage appendix.tex", exact: true })
        .count()),
    "Deleted file disappears",
  );
  console.info("Rendered file rename, move, and deletion passed");
  await owner.getByRole("button", { name: "Settings", exact: true }).click();
  await owner
    .getByRole("dialog")
    .getByLabel("Theme", { exact: true })
    .selectOption("oneDark");
  assert.equal(
    await owner
      .getByRole("dialog")
      .evaluate((dialog) => getComputedStyle(dialog).borderRadius),
    "0px",
    "Editor settings use the square editor style",
  );
  await capture(owner, "settings-dark");
  await owner.keyboard.press("Escape");
  await owner
    .locator('[data-slot="dialog-content"]')
    .waitFor({ state: "detached" });
  await capture(owner, "workspace-dark");
  await owner.locator('[data-testid="git-panel"]').waitFor();
  await capture(owner, "git-dark");
  await owner.setViewportSize({ width: 375, height: 812 });
  await owner
    .getByRole("button", { name: "Toggle project sidebar", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Close project sidebar", exact: true })
    .waitFor();
  await owner.waitForFunction(() => {
    const popup = document.querySelector(
      '[data-slot="sidebar"][data-mobile="true"]',
    );
    if (!popup) return false;
    return (
      !popup.hasAttribute("data-starting-style") &&
      getComputedStyle(popup).opacity === "1" &&
      popup.getBoundingClientRect().right <= innerWidth + 1
    );
  });
  await capture(owner, "workspace-mobile-sidebar");
  await owner
    .getByRole("button", { name: "Close project sidebar", exact: true })
    .click();
  await owner
    .locator('[data-slot="sidebar"][data-mobile="true"]')
    .waitFor({ state: "detached" });
  await owner.getByRole("tab", { name: "main.tex", exact: true }).click();
  await owner.locator('.cm-content[contenteditable="true"]').waitFor();
  await capture(owner, "workspace-mobile");
  await owner.goto(`${origin}/templates/publish`);
  await owner
    .getByRole("heading", { name: "Publish a template", exact: true })
    .waitFor();
  await capture(owner, "publish-mobile");
  await owner.goto(`${origin}/templates/review`);
  await owner
    .getByRole("heading", { name: "Template review", exact: true })
    .waitFor();
  await capture(owner, "review-mobile");
  await owner.goto(`${origin}/accept-invitation/${invitationId}`);
  await owner
    .getByRole("heading", { name: "Join Research group", exact: true })
    .waitFor();
  await capture(owner, "invitation-mobile");
  await owner
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await owner.waitForURL("**/projects");
  assert(
    await db.query.member.findFirst({
      where: { organizationId, userId: ownerId },
    }),
  );
  await owner.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await capture(owner, "projects-mobile");
  await owner.getByRole("button", { name: "New project", exact: true }).click();
  await capture(owner, "new-project-mobile");
  await owner
    .getByLabel("Project Name", { exact: true })
    .fill("A new beginning");
  await owner
    .getByRole("button", { name: "Create Project", exact: true })
    .click();
  await owner
    .getByRole("heading", { name: "A new beginning", exact: true })
    .waitFor();
  await owner
    .getByRole("link", { name: "Back to Projects", exact: true })
    .click();
  await owner
    .getByRole("textbox", { name: "Search projects", exact: true })
    .fill("A new beginning");
  await owner
    .getByRole("link", { name: "A study of small things", exact: true })
    .waitFor({ state: "detached" });
  await owner
    .getByRole("button", { name: "Delete A new beginning", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await owner.getByText("No matching projects", { exact: true }).waitFor();
  await owner
    .getByRole("button", { name: "Toggle Sidebar", exact: true })
    .click();
  await owner.getByRole("button", { name: "Sign out", exact: true }).click();
  await owner.waitForURL(origin + "/");
  console.info(
    "Invitation acceptance, project creation/search/deletion, and sign-out passed",
  );
  assert.deepEqual(errors, [], "No browser or hydration errors");
  console.info(`UI overhaul checks passed. Screenshots: ${screenshots}`);
} catch (error) {
  for (const [index, page] of browser
    .contexts()
    .flatMap((context) => context.pages())
    .entries()) {
    await page
      .screenshot({
        path: join(screenshots, `failure-${index}.png`),
        fullPage: true,
        animations: "disabled",
      })
      .catch(() => {});
    console.error(
      await page
        .locator("body")
        .ariaSnapshot()
        .catch(() => "No page snapshot"),
    );
  }
  throw error;
} finally {
  await browser.close();
  await mf.dispose();
  await db.delete(template).where(eq(template.id, templateId));
  await db.delete(organization).where(eq(organization.id, organizationId));
  for (const id of [ownerId, readerId])
    await db.delete(user).where(eq(user.id, id));
  await db.$client.end();
  await rm(directory, { recursive: true, force: true });
}
