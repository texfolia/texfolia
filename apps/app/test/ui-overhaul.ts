import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@texfolia/db";
import {
  invitation,
  member,
  organization,
  project as projectTable,
  projectCollaborator,
  projectNode,
  session,
  template,
  user,
} from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import { Miniflare } from "miniflare";
import { chromium, type Page } from "playwright";

import {
  createProject,
  getProjects,
  setProjectTags,
} from "../src/lib/projects/project.server";
import { lockProject } from "../src/lib/sharing/project-access.server";
import {
  grantProjectAccess,
  revokeProjectAccess,
} from "../src/lib/sharing/project-sharing.server";
import { withBuildsFixture } from "./builds/miniflare";
import { pdfFixture } from "./pdf-fixture";

const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Use an isolated Postgres test database",
);
const db = createDb(connectionString);
const root = new URL("../dist/server/", import.meta.url).pathname;
const filenames = await readdir(root, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "texfolia-ui-"));
const screenshots = new URL("../../../.audit/nat-314/", import.meta.url)
  .pathname;
await mkdir(screenshots, { recursive: true });
const secret = "ui-overhaul-test-secret-not-for-production";
const ownerId = crypto.randomUUID();
const readerId = crypto.randomUUID();
const organizationId = crypto.randomUUID();
const invitationId = crypto.randomUUID();
const templateId = crypto.randomUUID();
let showArtifacts = false;
const portReservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = portReservation.port;
await portReservation.stop(true);
assert(port);
const mf = new Miniflare({
  ...withBuildsFixture(
    {
      name: "ui-overhaul-test",
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
    },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/build/files"))
        return new Response(
          new URL(request.url).searchParams.get("path")?.endsWith(".pdf")
            ? pdfFixture()
            : "Generated output fixture\n",
          {
            headers: { "Content-Type": "text/plain" },
          },
        );
      if (path.endsWith("/pdf")) return new Response(null, { status: 404 });
      if (path.endsWith("/changed")) return new Response(null, { status: 204 });
      const snapshot = {
        revision: 0,
        current: null,
        latestBuild: null,
        stale: false,
        artifacts: showArtifacts
          ? {
              id: "fixture-build",
              revision: 0,
              digest: "fixture",
              builtAt: new Date().toISOString(),
              builtBy: "UI fixture",
              engine: "tectonic",
              pdf: null,
              files: [
                { path: "output.pdf", key: "pdf-v1", sizeBytes: 500 },
                { path: "main.log", key: "log-v1", sizeBytes: 25 },
                { path: "nested/main.aux", key: "aux-v1", sizeBytes: 25 },
              ],
            }
          : null,
      };
      if (path.endsWith("/events"))
        return new Response(`${JSON.stringify(snapshot)}\n`);
      return Response.json(snapshot);
    },
  ),
  port,
  resourcePersistencePath: directory,
});
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
async function workspaceMenu(page: Page, menu: string, item: string) {
  await page
    .locator('[data-slot="menubar-trigger"]')
    .filter({ hasText: new RegExp(`^${menu}$`) })
    .click();
  const entry = page.getByRole("menuitem", { name: item, exact: true });
  await entry.focus();
  await page.keyboard.press("Enter");
}
// The bottom panel's Problems tab includes the problem count.
function problemsTab(page: Page) {
  return page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: /^Problems \(\d+\)$/ });
}
async function sidebarView(page: Page, view: string) {
  const names: Record<string, string> = {
    files: "Files",
    outline: "Outline",
    search: "Search",
    git: "Git",
    collaboration: "Collaboration",
  };
  const button = page
    .getByRole("toolbar", { name: "Right sidebar views" })
    .getByRole("button", { name: names[view] ?? view, exact: true });
  if ((await button.getAttribute("aria-pressed")) !== "true")
    await button.click();
}
async function fileMenu(page: Page, name: string, item: string) {
  await page
    .getByRole("button", { name, exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}
function monitor(page: Page) {
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|hydrated|React error|content security policy/i.test(
        message.text(),
      )
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
async function eventually(
  check: () => boolean | Promise<boolean>,
  label: string,
) {
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
  const referencePdf = pdfFixture();
  const pdfKey = `projects/${project.id}/sources/${createHash("sha256").update(referencePdf).digest("hex")}`;
  await (await mf.getR2Bucket("SOURCES")).put(pdfKey, referencePdf);
  await db.insert(projectNode).values({
    projectId: project.id,
    parentId: rootNode.id,
    name: "reference.pdf",
    kind: "binary",
    objectKey: pdfKey,
    sizeBytes: BigInt(referencePdf.length),
  });

  await db.insert(projectNode).values({
    projectId: project.id,
    parentId: rootNode.id,
    name: "notes.tex",
    kind: "text",
    sizeBytes: 0n,
  });
  const appendix = Buffer.from("Unopened appendix text\n");
  const appendixKey = `projects/${project.id}/sources/${createHash("sha256").update(appendix).digest("hex")}`;
  await (await mf.getR2Bucket("SOURCES")).put(appendixKey, appendix);
  const appendixId = crypto.randomUUID();
  await db.insert(projectNode).values({
    id: appendixId,
    projectId: project.id,
    parentId: rootNode.id,
    name: "unopened.tex",
    kind: "text",
    objectKey: appendixKey,
    sizeBytes: BigInt(appendix.length),
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
    // Signing out lands on /login. With no site key in CI, the real Turnstile
    // script throws, so block it as the public context does.
    await context.route("https://challenges.cloudflare.com/**", (route) =>
      route.abort(),
    );
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
  // Marketing /, /pricing, /privacy, /terms, /templates live on apps/web.
  // Product public surfaces here: template detail and login.
  for (const width of [1440, 768, 375, 320]) {
    await publicPage.setViewportSize({ width, height: 1000 });
    for (const [path, heading, name] of [
      [`/template/${templateId}`, "A simple article", "template"],
      ["/login", "Sign in to Texfolia", "login"],
    ]) {
      await publicPage.goto(`${origin}${path}`);
      await publicPage
        .getByRole("heading", { level: 1 })
        .filter({ hasText: heading })
        .waitFor();
      if (path === "/login") {
        const signIn = publicPage.getByRole("form", {
          name: "Sign in",
          exact: true,
        });
        assert.equal(
          await signIn
            .getByRole("button", {
              name: /^Continue with (GitHub|GitLab|Google|Microsoft)$/,
            })
            .count(),
          4,
        );
        await signIn.evaluate(async (form) => {
          await Promise.all(
            [...form.querySelectorAll("img")].map((image) => image.decode()),
          );
        });
        assert.equal(
          await publicPage
            .getByRole("link", { name: "Skip to sign-in form" })
            .count(),
          1,
        );
      }
      await capture(publicPage, `${name}-${width}`);
    }
  }
  await publicPage.goto(origin);
  await publicPage.waitForURL(/\/login/);
  await publicPage.goto(`${origin}/template/${templateId}`);
  const navigation = publicPage.getByRole("navigation", {
    name: "Main navigation",
  });
  assert.deepEqual(await navigation.getByRole("link").allTextContents(), [
    "Templates",
    "Pricing",
  ]);
  for (const [label, path] of [
    ["Templates", "/templates"],
    ["Pricing", "/pricing"],
  ] as const) {
    const href = await navigation
      .getByRole("link", { name: label, exact: true })
      .getAttribute("href");
    assert(href, `${label} link missing href`);
    const url = new URL(href);
    assert.equal(url.pathname, path);
    assert.match(url.protocol, /^https?:$/);
    assert.notEqual(
      url.origin,
      new URL(origin).origin,
      `${label} must point at the marketing origin`,
    );
  }
  console.info(
    "Product public routes fit desktop, tablet, and narrow mobile viewports",
  );
  const owner = await newSession(ownerId);
  const reader = await newSession(readerId);
  await owner.goto(`${origin}/projects`);
  await owner.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await capture(owner, "projects-desktop");
  await reader.goto(`${origin}/projects`);
  await reader.getByText("No projects yet", { exact: true }).waitFor();
  await capture(reader, "projects-empty-desktop");
  assert.equal(
    await reader.getByRole("table").count(),
    0,
    "Dedicated empty screen has no table",
  );
  await reader
    .getByRole("button", { name: "Create your first project", exact: true })
    .click();
  await reader
    .getByRole("dialog", { name: "New project", exact: true })
    .waitFor();
  await capture(reader, "projects-empty-dialog");
  await reader.keyboard.press("Escape");
  await owner.getByRole("button", { name: "New project", exact: true }).hover();
  await owner.getByRole("tooltip").filter({ hasText: "N then P" }).waitFor();
  await owner.getByRole("heading", { name: "Projects", exact: true }).click();
  await owner.keyboard.press("n");
  await owner.keyboard.press("p");
  const newProject = owner.getByRole("dialog", {
    name: "New project",
    exact: true,
  });
  await newProject.waitFor();
  assert.equal(
    await newProject.getByRole("button", { name: /^Template/ }).count(),
    1,
  );
  assert.equal(
    await newProject.getByRole("button", { name: /^Git repository/ }).count(),
    1,
  );
  assert.equal(
    await newProject.getByRole("button", { name: /^Files or folder/ }).count(),
    1,
  );
  await newProject.getByRole("button", { name: /^Git repository/ }).click();
  await newProject.getByLabel("Repository URL", { exact: true }).waitFor();
  assert.equal(
    await owner.locator("details").count(),
    0,
    "No page-level import disclosure",
  );
  await newProject
    .getByRole("button", { name: "All options", exact: true })
    .click();
  await newProject.getByRole("button", { name: /^Template/ }).click();
  await newProject.getByRole("radio", { name: /A simple article/ }).check();
  await newProject
    .getByLabel("Project name", { exact: true })
    .fill("Dialog template");
  await capture(owner, "new-project-template");
  await newProject
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await owner.waitForURL(/\/project\//);
  await owner.locator('.cm-content[contenteditable="true"]').waitFor();
  const templateCopy = (
    await getProjects({ db, userId: ownerId })
  ).projects.find((item) => item.name === "Dialog template");
  assert(templateCopy, "Template created with the in-dialog name");
  await owner.goto(`${origin}/projects`);
  await owner.getByRole("button", { name: "New project", exact: true }).click();
  await newProject.getByRole("button", { name: /^Files or folder/ }).click();
  await newProject.getByLabel("Project files", { exact: true }).setInputFiles([
    {
      name: "main.tex",
      mimeType: "text/plain",
      buffer: Buffer.from("% imported document\n"),
    },
    {
      name: "references.bib",
      mimeType: "text/plain",
      buffer: Buffer.from("@book{test,title={Example}}"),
    },
  ]);
  await newProject
    .getByLabel("Project name", { exact: true })
    .fill("Dialog files");
  await newProject
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await owner.waitForURL(/\/project\//);
  await owner.locator('.cm-content[contenteditable="true"]').waitFor();
  assert.match(
    await owner.locator('.cm-content[contenteditable="true"]').innerText(),
    /imported document/,
  );
  const folderPath = join(directory, "Folder import");
  await mkdir(join(folderPath, "chapters"), { recursive: true });
  await writeFile(join(folderPath, "main.tex"), "% folder document\n");
  await writeFile(
    join(folderPath, "chapters", "intro.tex"),
    "A nested chapter.",
  );
  await owner.goto(`${origin}/projects`);
  await owner.getByRole("button", { name: "New project", exact: true }).click();
  await newProject.getByRole("button", { name: /^Files or folder/ }).click();
  await newProject
    .getByLabel("Project folder", { exact: true })
    .setInputFiles(folderPath);
  await newProject
    .getByLabel("Project name", { exact: true })
    .fill("Dialog folder");
  await newProject
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await owner.waitForURL(/\/project\//);
  const importedId = new URL(owner.url()).pathname.split("/").at(-1);
  assert(importedId);
  const importedNodes = await db.query.projectNode.findMany({
    where: { projectId: importedId },
  });
  const chapter = importedNodes.find((node) => node.name === "chapters");
  assert(
    chapter &&
      importedNodes.some(
        (node) => node.name === "intro.tex" && node.parentId === chapter.id,
      ),
    "Folder hierarchy preserved",
  );
  await owner.goto(`${origin}/projects`);
  const dashboardRow = owner.getByRole("row").filter({
    has: owner.getByRole("link", { name: project.name, exact: true }),
  });
  await dashboardRow
    .getByRole("button", { name: `Actions for ${project.name}`, exact: true })
    .click();
  await owner.getByRole("menuitem", { name: "Your tags", exact: true }).click();
  await owner.getByLabel("Your tags", { exact: true }).fill("Research, Draft");
  await owner
    .getByRole("dialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await owner.getByRole("dialog").waitFor({ state: "detached" });
  await owner.reload();
  await dashboardRow.getByText("research", { exact: true }).waitFor();
  const noRefetch: string[] = [];
  const recordFetch = (request: import("playwright").Request) => {
    if (request.resourceType() === "fetch") noRefetch.push(request.url());
  };
  owner.on("request", recordFetch);
  await owner
    .getByLabel("Filter by tag", { exact: true })
    .selectOption("research");
  assert.equal(await owner.getByRole("table").getByRole("link").count(), 1);
  await owner.getByLabel("Filter by tag", { exact: true }).selectOption("");
  await owner
    .getByRole("columnheader")
    .getByRole("button", { name: "Project", exact: true })
    .click();
  const namesAscending = await owner
    .getByRole("table")
    .getByRole("link")
    .allTextContents();
  assert.deepEqual(
    namesAscending,
    [...namesAscending].sort((a, b) => a.localeCompare(b)),
  );
  await owner
    .getByRole("columnheader")
    .getByRole("button", { name: "Project", exact: true })
    .click();
  assert.deepEqual(
    await owner.getByRole("table").getByRole("link").allTextContents(),
    [...namesAscending].reverse(),
  );
  await owner
    .getByRole("textbox", { name: "Search projects", exact: true })
    .fill("no such project");
  await owner.getByText("No matching projects", { exact: true }).waitFor();
  assert.equal(
    await owner.getByText("No projects yet", { exact: true }).count(),
    0,
  );
  await owner
    .getByRole("button", { name: "Clear filters", exact: true })
    .first()
    .click();
  owner.off("request", recordFetch);
  assert.deepEqual(noRefetch, [], "Filtering and sorting do not fetch");
  await dashboardRow
    .getByRole("button", { name: `Actions for ${project.name}`, exact: true })
    .click();
  await owner.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await owner
    .getByRole("dialog")
    .getByLabel("Project name", { exact: true })
    .fill("Renamed study");
  await owner
    .getByRole("dialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await owner
    .getByRole("table")
    .getByRole("link", { name: "Renamed study", exact: true })
    .waitFor();
  const renamedRow = owner.getByRole("row").filter({
    has: owner.getByRole("link", { name: "Renamed study", exact: true }),
  });
  await renamedRow
    .getByRole("button", { name: "Actions for Renamed study", exact: true })
    .click();
  await owner.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await owner
    .getByRole("dialog")
    .getByLabel("Project name", { exact: true })
    .fill(project.name);
  await owner
    .getByRole("dialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await dashboardRow.waitFor();
  await dashboardRow
    .getByRole("button", { name: `Actions for ${project.name}`, exact: true })
    .click();
  await owner.getByRole("menuitem", { name: "Share", exact: true }).click();
  await owner
    .getByRole("dialog")
    .getByRole("form", { name: "Share project", exact: true })
    .waitFor();
  await owner.keyboard.press("Escape");
  await dashboardRow
    .getByRole("button", { name: `Actions for ${project.name}`, exact: true })
    .click();
  const dashboardDownloadReady = owner.waitForEvent("download");
  await owner
    .getByRole("menuitem", { name: "Download ZIP", exact: true })
    .click();
  const dashboardDownload = await dashboardDownloadReady;
  assert.equal(dashboardDownload.suggestedFilename(), `${project.name}.zip`);
  await capture(owner, "projects-redesigned-desktop");
  console.info(
    "Projects dialog template/files/folder creation, default N P, tag persistence, client filtering/sorting, rename/share/download passed",
  );

  await owner.getByRole("link", { name: "Settings", exact: true }).click();
  await owner.waitForURL("**/settings/preferences");
  await owner
    .getByRole("heading", { name: "Preferences", exact: true })
    .waitFor();
  await owner
    .getByRole("button", { name: "Follow system appearance", exact: true })
    .waitFor();
  await capture(owner, "settings-preferences-desktop");
  await owner.setViewportSize({ width: 390, height: 844 });
  await capture(owner, "settings-preferences-mobile");
  await owner.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(
    await owner.getByRole("dialog").count(),
    0,
    "Outside editor settings is a route",
  );
  await owner.getByRole("button", { name: "Editor", exact: true }).click();
  const pageFont = owner.getByRole("spinbutton", { name: "Editor font size" });
  await pageFont.fill("17");
  const settingsNav = owner.getByRole("navigation", {
    name: "Settings",
    exact: true,
  });
  await settingsNav.getByRole("link", { name: "Account", exact: true }).click();
  const settingsGuard = owner.getByRole("alertdialog");
  await settingsGuard
    .getByRole("button", { name: "Apply", exact: true })
    .click();
  await settingsGuard.waitFor({ state: "detached" });
  assert(
    owner.url().endsWith("/settings/preferences"),
    "Leave-guard Apply stays on Preferences",
  );
  assert.equal(
    await owner
      .getByRole("button", { name: "Apply", exact: true })
      .isDisabled(),
    true,
  );
  await pageFont.fill("18");
  await settingsNav.getByRole("link", { name: "Account", exact: true }).click();
  await settingsGuard
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await owner.getByRole("heading", { name: "Account", exact: true }).waitFor();
  await owner
    .getByRole("button", { name: "Save profile", exact: true })
    .click();
  await owner
    .getByRole("status")
    .filter({ hasText: "Profile saved." })
    .waitFor();

  await owner.route("**/api/auth/delete-user", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        message: "Deletion email unavailable. Try again.",
        code: "MAIL_UNAVAILABLE",
      }),
    }),
  );
  await owner
    .getByRole("button", { name: "Delete account", exact: true })
    .click();
  const deleteGuard = owner.getByRole("alertdialog");
  await deleteGuard
    .getByRole("button", { name: "Send deletion link", exact: true })
    .click();
  await deleteGuard
    .getByRole("alert")
    .filter({ hasText: "Deletion email unavailable" })
    .waitFor();
  await capture(owner, "settings-account-deletion-error");
  await deleteGuard
    .getByRole("button", { name: "Keep account", exact: true })
    .click();
  await owner.unroute("**/api/auth/delete-user");
  for (const label of ["Connections", "AI", "Usage"]) {
    await settingsNav.getByRole("link", { name: label, exact: true }).click();
    await owner.getByRole("heading", { name: label, exact: true }).waitFor();
  }
  await owner
    .getByRole("spinbutton", {
      name: "Monthly AI spend cap (USD)",
      exact: true,
    })
    .fill("15.00");
  await owner.getByRole("button", { name: "Save cap", exact: true }).click();
  await owner
    .getByRole("status")
    .filter({ hasText: "Monthly cap saved." })
    .waitFor();
  await owner.goto(`${origin}/billing?plan=team`);
  await owner.waitForURL("**/settings/billing?plan=team");
  await owner
    .getByRole("heading", { name: "Start a Team plan", exact: true })
    .waitFor();
  await owner.keyboard.press("ControlOrMeta+K");
  await owner.keyboard.press("ControlOrMeta+S");
  await owner.waitForURL("**/settings/preferences?section=shortcuts");
  await owner
    .getByRole("heading", { name: "Keyboard shortcuts", exact: true })
    .waitFor();
  const recordProject = owner.getByRole("button", {
    name: "Record New project",
    exact: true,
  });
  await recordProject.click();
  await owner.keyboard.press("g");
  await owner.keyboard.press("p");
  await owner.keyboard.press("Enter");
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await owner.waitForURL("**/projects");
  const projectSearch = owner.getByRole("textbox", {
    name: "Search projects",
    exact: true,
  });
  await projectSearch.fill("");
  await projectSearch.pressSequentially("gp");
  assert.equal(
    await owner.getByRole("dialog").count(),
    0,
    "Sequences are ignored while typing",
  );
  await projectSearch.fill("");
  await owner.getByRole("heading", { name: "Projects", exact: true }).click();
  await owner.keyboard.press("g");
  await owner.keyboard.press("p");
  await owner.getByRole("dialog").waitFor();
  await owner.keyboard.press("Escape");
  await owner.getByRole("dialog").waitFor({ state: "detached" });
  console.info(
    "Settings routes, AI cap, billing redirect, preferences draft/leave guard, recorded sequences and typing exclusions passed",
  );
  assert.equal(
    await owner.getByRole("checkbox").count(),
    0,
    "No inert bulk selection",
  );
  const projectRow = owner.getByRole("row").filter({
    has: owner.getByRole("link", { name: project.name, exact: true }),
  });
  await projectRow.locator("[data-slot=avatar]").waitFor();
  assert.equal(await projectRow.locator("img").count(), 0, "No demo avatars");
  assert.equal(await projectRow.getByRole("button").count(), 1);
  await projectRow
    .getByRole("button", { name: `Actions for ${project.name}`, exact: true })
    .waitFor();
  const sockets = new Map<string, number>();
  owner.on("websocket", (socket) => {
    const { pathname } = new URL(socket.url());
    if (!pathname.startsWith("/api/collaboration/")) return;
    const nodeId = pathname.split("/").at(-1) ?? "";
    sockets.set(nodeId, (sockets.get(nodeId) ?? 0) + 1);
    socket.on("close", () =>
      sockets.set(nodeId, (sockets.get(nodeId) ?? 1) - 1),
    );
  });
  await projectRow
    .getByRole("link", { name: project.name, exact: true })
    .focus();
  await owner.keyboard.press("Enter");
  await owner.locator('.cm-content[contenteditable="true"]').waitFor();
  await owner.mouse.click(2, 2);
  await owner.keyboard.press("Tab");
  const skipToEditor = owner.getByRole("link", {
    name: "Skip to editor",
    exact: true,
  });
  assert.equal(
    await skipToEditor.evaluate((link) => link === document.activeElement),
    true,
    "Skip link is the first workspace tab stop",
  );
  await owner.keyboard.press("Enter");
  assert.equal(
    await owner
      .getByRole("main", { name: "Editor", exact: true })
      .evaluate((main) => main === document.activeElement),
    true,
    "Skip link focuses the workspace main landmark",
  );
  await sidebarView(owner, "collaboration");
  await owner.getByRole("form", { name: "Share project" }).waitFor();
  await owner
    .getByText("Only the owner has access.", { exact: true })
    .waitFor();
  await sidebarView(owner, "files");
  const geometry = await owner.evaluate(() => {
    const sidebar = document.querySelector('[aria-label="Project sidebar"]');
    const editor = document.querySelector(".cm-editor");
    const row = document.querySelector('[aria-label="Project files"] button');
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
  assert.equal(geometry.rowRadius, "0px", "File rows are square and flush");
  assert.equal(geometry.rowHeight, 24);
  assert.equal(await owner.locator('[data-slot="menubar"]').count(), 1);
  assert.equal(
    await owner.getByRole("complementary", { name: "Project sidebar" }).count(),
    1,
  );
  assert.equal(
    await owner.locator('[aria-label="Workspace navigation"]').count(),
    0,
  );
  await owner.getByRole("complementary", { name: "AI assistant" }).waitFor();
  assert.equal(
    await owner
      .getByRole("button", { name: "Find and replace", exact: true })
      .evaluate((button) => getComputedStyle(button).borderColor),
    "rgba(0, 0, 0, 0)",
    "Ghost panel tools have no visible border",
  );
  const treeGeometry = await owner.evaluate(() => {
    const sidebar = document.querySelector('[aria-label="Project sidebar"]');
    const root = document.querySelector('[aria-label="Project files"] button');
    if (!sidebar || !root) throw new Error("Missing file tree");
    return {
      left:
        root.getBoundingClientRect().left -
        sidebar.getBoundingClientRect().left,
      top:
        root.getBoundingClientRect().top - sidebar.getBoundingClientRect().top,
    };
  });
  assert.deepEqual(
    treeGeometry,
    { left: 0, top: 0 },
    "Files view is only a flush tree",
  );
  await capture(owner, "workspace-desktop");
  await owner.getByRole("button", { name: "notes.tex", exact: true }).click();
  await owner.getByRole("tab", { name: "notes.tex", exact: true }).waitFor();
  assert.equal(
    await owner
      .getByRole("tab", { name: "notes.tex", exact: true })
      .evaluate(
        (tab) =>
          getComputedStyle(
            tab.querySelector("[data-slot=context-menu-trigger]") ?? tab,
          ).fontStyle,
      ),
    "italic",
  );
  await owner
    .getByRole("button", { name: "notes.tex", exact: true })
    .dblclick();
  assert.equal(
    await owner
      .getByRole("tab", { name: "notes.tex", exact: true })
      .evaluate(
        (tab) =>
          getComputedStyle(
            tab.querySelector("[data-slot=context-menu-trigger]") ?? tab,
          ).fontStyle,
      ),
    "normal",
  );
  await owner
    .getByRole("tab", { name: "notes.tex", exact: true })
    .click({ button: "right" });
  await owner.getByRole("menuitem", { name: "Close", exact: true }).click();
  const nodeIds = new Map(
    (
      await db.query.projectNode.findMany({ where: { projectId: project.id } })
    ).map((node) => [node.name, node.id]),
  );
  const notesId = nodeIds.get("notes.tex") ?? "";
  await eventually(
    () => sockets.get(notesId) === 0,
    "Closing a tab closes its collaboration socket",
  );
  assert.deepEqual(
    [...sockets.keys()].sort(),
    [nodeIds.get("main.tex") ?? "", notesId].sort(),
    "Files that were never opened never connect",
  );
  await owner.getByRole("tab", { name: "main.tex", exact: true }).click();
  await owner.locator('.cm-content[contenteditable="true"]').fill("Bold text");
  await owner.keyboard.press("ControlOrMeta+A");
  await owner.keyboard.press("ControlOrMeta+B");
  assert.match(
    await owner.locator('.cm-content[contenteditable="true"]').innerText(),
    /\\textbf\{Bold text\}/,
  );
  assert.equal(
    await owner
      .getByRole("toolbar", { name: "Right sidebar views" })
      .getByRole("button", { name: "Files", exact: true })
      .getAttribute("aria-pressed"),
    "true",
    "Editor bold does not toggle the sidebar",
  );
  await owner
    .locator('.cm-content[contenteditable="true"]')
    .fill("\\section{Workspace heading}\n");
  await sidebarView(owner, "outline");
  await owner
    .getByRole("navigation", { name: "Document outline" })
    .getByRole("button", { name: "Workspace heading", exact: true })
    .click();
  assert.equal(await owner.getByRole("tab", { name: /^main\.tex/ }).count(), 1);
  await owner.locator('.cm-content[contenteditable="true"]').click();
  await owner.keyboard.press("ControlOrMeta+Shift+F");
  const fileSearch = owner.getByRole("searchbox", {
    name: "Search project files",
  });
  await eventually(
    () => fileSearch.evaluate((input) => input === document.activeElement),
    "Mod+Shift+F focuses project search",
  );
  await fileSearch.fill("workspace HEADING");
  await owner
    .getByRole("status")
    .filter({ hasText: "1 result in 1 file" })
    .waitFor();
  await owner
    .getByRole("region", { name: "main.tex", exact: true })
    .getByRole("button", { name: /Workspace heading/ })
    .click();
  assert.equal(
    await owner.evaluate(() => document.getSelection()?.toString()),
    "Workspace heading",
    "Selecting a search result selects the match",
  );
  assert(!sockets.has(appendixId));
  await fileSearch.fill("unopened APPENDIX");
  await owner
    .getByRole("status")
    .filter({ hasText: "1 result in 1 file" })
    .waitFor();
  // A collaborator's saved edit reaches search without opening the file.
  const edited = Buffer.from("Unopened appendix text, edited elsewhere\n");
  const editedKey = `projects/${project.id}/sources/${createHash("sha256").update(edited).digest("hex")}`;
  await (await mf.getR2Bucket("SOURCES")).put(editedKey, edited);
  await db
    .update(projectNode)
    .set({
      objectKey: editedKey,
      sizeBytes: BigInt(edited.length),
      updatedAt: new Date(),
    })
    .where(eq(projectNode.id, appendixId));
  await fileSearch.fill("edited elsewhere");
  await owner
    .getByRole("region", { name: "unopened.tex", exact: true })
    .getByRole("button", { name: /edited elsewhere/ })
    .click();
  await eventually(
    () =>
      owner.evaluate(
        () => document.getSelection()?.toString() === "edited elsewhere",
      ),
    "Selecting a result opens an unopened file at the match",
  );
  assert.equal(sockets.get(appendixId), 1);
  await owner
    .getByRole("tab", { name: "unopened.tex", exact: true })
    .getByRole("button", { name: "Close tab" })
    .click();
  await owner.getByRole("tab", { name: /^main\.tex/ }).click();
  await owner.locator('.cm-content[contenteditable="true"]').fill("");
  await sidebarView(owner, "files");

  assert.equal(
    await owner.getByRole("tab", { name: "PDF Preview", exact: true }).count(),
    0,
    "No permanent or empty PDF viewer",
  );
  await owner
    .getByRole("button", { name: "reference.pdf", exact: true })
    .click();
  await owner
    .getByRole("tab", { name: "reference.pdf", exact: true })
    .waitFor();
  await owner.locator(".react-pdf__Page__canvas").waitFor();
  await capture(owner, "pdf-source-tab");
  await owner
    .getByRole("tab", { name: "reference.pdf", exact: true })
    .getByRole("button", { name: "Close tab" })
    .click();
  await owner.getByRole("tab", { name: /^main\.tex/ }).click();
  await sidebarView(owner, "collaboration");
  const share = owner.getByRole("form", { name: "Share project" });
  await share.getByRole("textbox").fill(`${crypto.randomUUID()}@example.com`);
  await share.getByRole("button", { name: "Share", exact: true }).click();
  await owner
    .getByRole("status")
    .filter({ hasText: "If that email has a Texfolia account" })
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
  await sharedRow.waitFor();
  assert.equal(await sharedRow.locator("[data-slot=avatar]").count(), 2);
  assert.deepEqual(
    (await getProjects({ db, userId: readerId })).projects.find(
      (item) => item.id === project.id,
    )?.tags,
    [],
  );
  await setProjectTags({
    db,
    ownerId: readerId,
    data: { projectId: project.id, tags: ["private-reader-tag"] },
  });
  assert.deepEqual(
    (await getProjects({ db, userId: ownerId })).projects.find(
      (item) => item.id === project.id,
    )?.tags,
    ["draft", "research"],
  );
  await setProjectTags({
    db,
    ownerId,
    data: { projectId: project.id, tags: [] },
  });
  assert.deepEqual(
    (await getProjects({ db, userId: readerId })).projects.find(
      (item) => item.id === project.id,
    )?.tags,
    ["private-reader-tag"],
  );

  await sharedRow
    .getByRole("button", { name: `Actions for ${project.name}`, exact: true })
    .click();
  assert.equal(
    await reader
      .getByRole("menuitem", { name: "Move to trash", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await reader.getByRole("menuitem", { name: "Rename", exact: true }).count(),
    0,
  );
  await reader.keyboard.press("Escape");
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
    .getByRole("button", { name: "notes.tex", exact: true })
    .click({ button: "right" });
  await reader.getByRole("menuitem", { name: "Rename", exact: true }).waitFor();
  await reader.keyboard.press("Escape");
  await share.getByRole("textbox").fill(`${readerId}@example.com`);
  await share.getByRole("combobox").selectOption("viewer");
  await share.getByRole("button", { name: "Share", exact: true }).click();
  await reader.locator('.cm-content[contenteditable="false"]').waitFor();
  await reader
    .getByRole("button", { name: "notes.tex", exact: true })
    .click({ button: "right" });
  assert.equal(
    await reader.getByRole("menuitem", { name: "Rename", exact: true }).count(),
    0,
  );
  await reader.keyboard.press("Escape");

  // The scratchpad is its own tab, outside the project's files. The owner
  // edits it while the reader, now a viewer, follows along.
  const scratchpadText = (page: Page) =>
    page
      .getByRole("region", { name: "Scratchpad editor", exact: true })
      .locator(".cm-content");
  const scratchpadTab = (page: Page, name: string) =>
    page.getByRole("tab", { name, exact: true });
  assert(!sockets.has("scratchpad"), "An unopened scratchpad never connects");
  for (const page of [owner, reader])
    await page
      .getByRole("button", { name: "Open scratchpad", exact: true })
      .click();
  await scratchpadTab(owner, "Scratchpad").waitFor();
  await scratchpadText(owner).click();
  await owner.keyboard.insertText("# Shared plan\n\n<b id=raw>raw</b>\n");
  await scratchpadText(reader)
    .getByText("# Shared plan", { exact: true })
    .waitFor();
  assert.equal(
    await scratchpadText(reader).getAttribute("contenteditable"),
    "false",
    "Viewers cannot edit the scratchpad",
  );
  await reader.locator(".cm-ySelectionCaret").first().waitFor();
  assert.equal(
    await owner
      .getByRole("region", { name: "Scratchpad editor", exact: true })
      .getByRole("button", { name: "Add comment", exact: true })
      .count(),
    0,
    "Review comments stay on project files",
  );
  await owner.keyboard.press("ControlOrMeta+Shift+V");
  const scratchpadPreview = owner.getByRole("region", {
    name: "Markdown preview",
    exact: true,
  });
  await scratchpadPreview
    .getByRole("heading", { name: "Shared plan", exact: true })
    .waitFor();
  assert.equal(await scratchpadPreview.locator("#raw").count(), 0);
  await capture(owner, "scratchpad-desktop");
  await scratchpadText(owner).click();
  await owner.keyboard.press("ControlOrMeta+End");
  await owner.keyboard.insertText("\n## Decisions\n");
  await scratchpadPreview
    .getByRole("heading", { name: "Decisions", exact: true })
    .waitFor();
  assert.equal(
    await db.query.projectNode.findFirst({
      where: {
        projectId: project.id,
        name: { in: ["Scratchpad", "scratchpad", "scratchpad.md"] },
      },
    }),
    undefined,
    "The scratchpad is not a project file",
  );
  for (const name of ["Preview: Scratchpad", "Scratchpad"])
    await scratchpadTab(owner, name)
      .getByRole("button", { name: "Close tab" })
      .click();
  await eventually(
    () => sockets.get("scratchpad") === 0,
    "Closing the scratchpad closes its collaboration socket",
  );
  await workspaceMenu(owner, "View", "Scratchpad");
  await scratchpadText(owner).getByText("## Decisions").waitFor();
  await owner.reload();
  await scratchpadText(owner).getByText("## Decisions").waitFor();
  for (const page of [owner, reader])
    await scratchpadTab(page, "Scratchpad")
      .getByRole("button", { name: "Close tab" })
      .click();
  console.info("Scratchpad editing, preview, viewer access, and reload passed");
  await sidebarView(owner, "collaboration");
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
  await projectRow.locator("[data-slot=avatar]").waitFor();
  await projectRow
    .getByRole("link", { name: project.name, exact: true })
    .click();
  await owner.locator('.cm-content[contenteditable="true"]').waitFor();
  console.info(
    "Real viewer/editor grants, role changes, authorization, and live revocation passed",
  );
  await sidebarView(owner, "files");
  await fileMenu(owner, "notes.tex", "Rename");
  await owner.getByRole("dialog").waitFor();
  await owner.keyboard.press("Escape");
  await owner.getByRole("dialog").waitFor({ state: "detached" });
  await fileMenu(owner, "notes.tex", "Move");
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
    .getByRole("button", { name: "appendix.tex", exact: true })
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
  await workspaceMenu(owner, "File", "Export project");
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
    "reference.pdf",
    "unopened.tex",
  ]);
  const unopenedSource = Bun.spawnSync([
    "unzip",
    "-p",
    zipPath,
    "unopened.tex",
  ]);
  assert.equal(
    unopenedSource.stdout.toString(),
    edited.toString(),
    "Export includes the saved text of closed files",
  );
  const mainSource = Bun.spawnSync(["unzip", "-p", zipPath, "main.tex"]);
  assert.equal(mainSource.exitCode, 0);
  assert(
    mainSource.stdout.toString().includes(exportMarker),
    "Export contains current editor content",
  );
  showArtifacts = true;
  await owner.reload();
  await owner.getByRole("button", { name: "out", exact: true }).waitFor();
  assert.equal(
    await owner.getByRole("tab", { name: "output.pdf", exact: true }).count(),
    0,
    "A PDF existing does not open a tab automatically",
  );
  await owner.getByRole("button", { name: "output.pdf", exact: true }).click();
  await owner.locator(".react-pdf__Page__canvas").waitFor();
  await capture(owner, "pdf-generated-tab");

  assert.equal(
    await owner
      .getByText("Generated build files (read-only)", { exact: true })
      .count(),
    0,
  );
  await owner.getByRole("button", { name: "main.log", exact: true }).click();
  await owner.getByRole("tab", { name: "main.log", exact: true }).waitFor();
  await owner.getByRole("button", { name: "main.aux", exact: true }).click();
  await owner
    .getByRole("tab", { name: "main.log", exact: true })
    .waitFor({ state: "detached" });
  await owner.getByRole("tab", { name: "main.aux", exact: true }).waitFor();
  await owner.getByRole("button", { name: "main.aux", exact: true }).dblclick();
  assert.equal(
    await owner
      .getByRole("tab", { name: "main.aux", exact: true })
      .evaluate(
        (tab) =>
          getComputedStyle(
            tab.querySelector("[data-slot=context-menu-trigger]") ?? tab,
          ).fontStyle,
      ),
    "normal",
  );
  await owner
    .getByRole("button", { name: "main.aux", exact: true })
    .click({ button: "right" });
  await owner
    .getByRole("menuitem", { name: "Download", exact: true })
    .waitFor();
  assert.equal(
    await owner.getByRole("menuitem", { name: "Rename", exact: true }).count(),
    0,
  );
  await owner.keyboard.press("Escape");
  await owner.getByRole("tab", { name: /^main\.tex/ }).click();
  await workspaceMenu(owner, "File", "Save without compiling");
  await owner.getByRole("tab", { name: "main.tex", exact: true }).waitFor();
  console.info(
    "Keyboard project navigation, file dialog focus, and source ZIP download passed",
  );
  await fileMenu(owner, "appendix.tex", "Delete");
  await owner
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await eventually(
    async () =>
      !(await owner
        .getByRole("button", { name: "appendix.tex", exact: true })
        .count()),
    "Deleted file disappears",
  );
  console.info("Rendered file rename, move, and deletion passed");
  await workspaceMenu(owner, "File", "Settings");
  const settings = owner.getByRole("dialog", {
    name: "Settings",
    exact: true,
  });
  await settings.getByRole("button", { name: "Dracula", exact: true }).click();
  assert.equal(
    await owner.getByRole("dialog").count(),
    1,
    "Editor Settings opens as a dialog",
  );
  await capture(owner, "settings-dark");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await settings.waitFor({ state: "detached" });
  await capture(owner, "workspace-dark");
  await sidebarView(owner, "git");
  await owner.locator('[data-testid="git-panel"]').waitFor();
  await capture(owner, "git-dark");
  // Sidebar dimensions, visibility, selection and dock arrangement survive a real reload.
  await owner.getByRole("separator", { name: "Resize agents sidebar" }).focus();
  await owner.keyboard.press("ArrowRight");
  await owner.getByRole("separator", { name: "Resize right sidebar" }).focus();
  await owner.keyboard.press("ArrowLeft");
  await owner
    .getByRole("button", { name: "Toggle agents sidebar", exact: true })
    .click();
  // The bottom panel stays closed until the user opens it.
  assert.equal(
    await owner.getByRole("tablist", { name: "Panel views" }).count(),
    0,
  );
  await workspaceMenu(owner, "View", "Problems");
  await problemsTab(owner).waitFor();
  await owner
    .getByRole("tab", { name: "main.tex", exact: true })
    .click({ button: "right" });
  await owner
    .getByRole("menuitem", { name: "Close others", exact: true })
    .click();
  await problemsTab(owner).waitFor();
  await owner
    .getByRole("tab", { name: "main.tex", exact: true })
    .click({ button: "right" });
  await owner.getByRole("menuitem", { name: "Close all", exact: true }).click();
  await problemsTab(owner).waitFor();
  await sidebarView(owner, "files");
  await owner.getByRole("button", { name: "main.tex", exact: true }).dblclick();
  await sidebarView(owner, "git");
  await owner.reload();
  await owner.getByRole("toolbar", { name: "Right sidebar views" }).waitFor();
  assert.equal(
    await owner
      .getByRole("toolbar", { name: "Right sidebar views" })
      .getByRole("button", { name: "Git", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await problemsTab(owner).waitFor();
  assert.equal(
    await owner
      .getByRole("button", { name: "Toggle agents sidebar", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  assert.equal(
    await owner
      .getByRole("separator", { name: "Resize right sidebar" })
      .getAttribute("aria-valuenow"),
    "304",
  );
  await owner
    .getByRole("button", { name: "Toggle agents sidebar", exact: true })
    .click();
  assert.equal(
    await owner
      .getByRole("separator", { name: "Resize agents sidebar" })
      .getAttribute("aria-valuenow"),
    "336",
  );
  await owner.setViewportSize({ width: 375, height: 812 });
  await owner
    .getByRole("button", { name: "Close project sidebar", exact: true })
    .waitFor();
  await capture(owner, "workspace-mobile-sidebar");
  await owner
    .getByRole("button", { name: "Close project sidebar", exact: true })
    .click();
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
  await owner.getByRole("button", { name: /^Template/ }).click();
  await owner
    .getByLabel("Project name", { exact: true })
    .fill("A new beginning");
  await owner
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await owner.waitForURL(/\/project\//);
  await owner.locator('.cm-content[contenteditable="true"]').waitFor();
  await workspaceMenu(owner, "File", "Back to Projects");
  await owner
    .getByRole("textbox", { name: "Search projects", exact: true })
    .fill("A new beginning");
  await owner
    .getByRole("table")
    .getByRole("link", { name: "A study of small things", exact: true })
    .waitFor({ state: "detached" });
  await owner
    .getByRole("button", { name: "Actions for A new beginning", exact: true })
    .click();
  await owner.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await owner
    .getByRole("table")
    .getByRole("link", { name: "A new beginning copy", exact: true })
    .waitFor();
  const trash = async (name: string) => {
    await owner
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    await owner
      .getByRole("menuitem", { name: "Move to trash", exact: true })
      .click();
    await owner
      .getByRole("button", { name: "Move to trash", exact: true })
      .click();
    await owner
      .getByRole("table")
      .getByRole("link", { name, exact: true })
      .waitFor({ state: "detached" });
  };
  await trash("A new beginning copy");
  await owner.getByRole("button", { name: "Undo", exact: true }).click();
  await owner
    .getByRole("table")
    .getByRole("link", { name: "A new beginning copy", exact: true })
    .waitFor();
  await trash("A new beginning copy");
  await trash("A new beginning");
  await owner.getByText("No matching projects", { exact: true }).waitFor();
  await owner.goto(`${origin}/projects?view=trash`);
  await owner.getByRole("heading", { name: "Trash", exact: true }).waitFor();
  await owner
    .getByRole("button", { name: "Restore A new beginning", exact: true })
    .waitFor();
  await capture(owner, "projects-trash-mobile");
  await owner
    .getByRole("button", { name: "Restore A new beginning", exact: true })
    .click();
  await owner
    .getByRole("button", {
      name: "Permanently delete A new beginning copy",
      exact: true,
    })
    .click();
  await owner
    .getByRole("button", { name: "Delete permanently", exact: true })
    .last()
    .click();
  await owner.getByText("Trash is empty", { exact: true }).waitFor();
  assert.deepEqual(
    (
      await db.query.project.findMany({
        columns: { name: true, deletedAt: true },
        where: { ownerId, name: { like: "A new beginning%" } },
      })
    ).map((row) => [row.name, row.deletedAt]),
    [["A new beginning", null]],
  );
  await owner.goto(`${origin}/projects`);
  await owner
    .getByRole("button", { name: "Actions for A new beginning", exact: true })
    .click();
  await owner
    .getByRole("menuitem", { name: "Transfer ownership", exact: true })
    .click();
  await owner
    .getByText(
      "Share the project with the new owner first, then transfer it.",
      { exact: true },
    )
    .waitFor();
  await owner.keyboard.press("Escape");
  await owner.getByRole("dialog").waitFor({ state: "detached" });
  const transferred = await db.query.project.findFirst({
    where: { ownerId, name: "A new beginning" },
  });
  assert(transferred);
  await db
    .insert(projectCollaborator)
    .values({ projectId: transferred.id, userId: readerId, role: "viewer" });
  await owner
    .getByRole("button", { name: "Actions for A new beginning", exact: true })
    .click();
  await owner
    .getByRole("menuitem", { name: "Transfer ownership", exact: true })
    .click();
  await owner.getByLabel("New owner", { exact: true }).selectOption(readerId);
  await capture(owner, "project-transfer-mobile");
  await owner
    .getByRole("button", { name: "Transfer ownership", exact: true })
    .click();
  await owner
    .getByLabel("New owner", { exact: true })
    .waitFor({ state: "detached" });
  await owner
    .getByRole("button", { name: "Actions for A new beginning", exact: true })
    .click();
  await owner
    .getByRole("menuitem", { name: "Duplicate", exact: true })
    .waitFor();
  assert.equal(
    await owner
      .getByRole("menuitem", { name: "Move to trash", exact: true })
      .count(),
    0,
    "The previous owner keeps only edit access",
  );
  await owner.keyboard.press("Escape");
  assert.equal(
    (await db.query.project.findFirst({ where: { id: transferred.id } }))
      ?.ownerId,
    readerId,
  );
  await db.delete(projectTable).where(eq(projectTable.id, transferred.id));
  await owner.goto(`${origin}/projects`);
  await owner.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await owner
    .getByRole("button", { name: "Toggle Sidebar", exact: true })
    .click();
  const cacheNames = {
    owner: `texfolia.yjs.${ownerId}.${project.id}.signout-test`,
    other: `texfolia.yjs.${readerId}.${project.id}.signout-test`,
  };
  const offlineEditor = await owner.context().newPage();
  monitor(offlineEditor);
  await offlineEditor.goto(`${origin}/project/${project.id}`);
  const offlineContent = offlineEditor
    .locator('.cm-content[contenteditable="true"]')
    .first();
  await offlineContent.waitFor();
  await offlineEditor.routeWebSocket("**/api/collaboration/**", (socket) =>
    socket.close(),
  );
  await owner.context().setOffline(true);
  await offlineEditor
    .getByText("Offline. Edits will merge when reconnected.")
    .first()
    .waitFor();
  await offlineContent.fill("Private unsynced sign-out draft");
  await owner.context().setOffline(false);
  let unloadPrompts = 0;
  offlineEditor.on("dialog", async (dialog) => {
    unloadPrompts++;
    await dialog.dismiss();
  });
  await owner.evaluate(async (names) => {
    localStorage.setItem(
      "texfolia.project.legacy.sources",
      "Private legacy draft",
    );
    for (const name of Object.values(names)) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("source");
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("source", "readwrite");
          transaction.objectStore("source").put("Offline draft", "text");
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
        request.onerror = () => reject(request.error);
      });
    }
  }, cacheNames);
  await owner
    .getByRole("button", { name: "Account menu", exact: true })
    .click();
  await owner.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  const signOutGuard = owner.getByRole("alertdialog");
  await signOutGuard.waitFor();
  await signOutGuard
    .getByText(/including any edits that have not synced/)
    .waitFor();
  await capture(owner, "projects-signout-mobile");
  assert.equal(new URL(owner.url()).pathname, "/projects");
  await signOutGuard
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert(
    (await owner.evaluate(() => indexedDB.databases())).some(
      ({ name }) => name === cacheNames.owner,
    ),
  );
  await owner
    .getByRole("button", { name: "Account menu", exact: true })
    .click();
  await owner.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await owner.evaluate(() => {
    const databases = indexedDB.databases.bind(indexedDB);
    indexedDB.databases = () => {
      indexedDB.databases = databases;
      return Promise.reject(new Error("Cache enumeration unavailable"));
    };
  });
  await signOutGuard
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await signOutGuard
    .getByRole("alert")
    .getByText(/local document copies could not be removed/)
    .waitFor();
  assert.equal(new URL(owner.url()).pathname, "/projects");
  assert(
    (await owner.evaluate(() => indexedDB.databases())).some(
      ({ name }) => name === cacheNames.owner,
    ),
  );
  await signOutGuard
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  // Sign-out assigns "/" which redirects to /projects then /login when signed out.
  await owner.waitForURL(/\/login/);
  await offlineEditor.waitForURL(/\/login/);
  assert.equal(
    unloadPrompts,
    0,
    "Confirmed sign-out closes dirty editors without another unload prompt",
  );
  const remainingCaches = await owner.evaluate(() => indexedDB.databases());
  assert(
    !remainingCaches.some(({ name }) =>
      name?.startsWith(`texfolia.yjs.${ownerId}.`),
    ),
  );
  assert(remainingCaches.some(({ name }) => name === cacheNames.other));
  assert(
    await owner.evaluate(
      () =>
        !Object.keys(localStorage).some(
          (key) =>
            key.startsWith("texfolia.project.") && key.endsWith(".sources"),
        ),
    ),
  );
  assert(
    await owner.evaluate(
      (userId) =>
        !Object.keys(localStorage).some((key) =>
          key.startsWith(`texfolia.workspace.layout.v1:${userId}:`),
        ),
      ownerId,
    ),
  );
  console.info(
    "Invitation acceptance, project creation/search/duplication/trash/restore/deletion/transfer, and sign-out passed",
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
