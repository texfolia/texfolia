import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import {
  appearanceStorageKey,
  legacyAppearanceStorageKey,
} from "@texfolia/editor/themes";
import { chromium } from "playwright";
import { createServer } from "vite";
import * as Y from "yjs";

import { encodeSource } from "../src/lib/project-source";
import type { ProjectDetails } from "../src/lib/project.functions";

const projectId = crypto.randomUUID();
const rootId = crypto.randomUUID();
const mainId = crypto.randomUUID();
const source =
  "\\documentclass{article}\n\\begin{document}\nHello themes\n\\end{document}";
const project: ProjectDetails = {
  id: projectId,
  ownerId: "upload-test",
  organizationId: null,
  name: "Theme preview",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  formatIndent: 2,
  formatWrap: true,
  formatWidth: 80,
  spellcheckLanguage: "en-US",
  canWrite: true,
  nodes: [
    { id: rootId, projectId, parentId: null, name: "root", kind: "folder" },
    { id: mainId, projectId, parentId: rootId, name: "main.tex", kind: "text" },
  ],
  sourceContents: { [mainId]: source },
  sourceVersions: { [mainId]: { objectKey: null, updatedAt: 0 } },
};
const doc = new Y.Doc();
doc.getText("source").insert(0, source);
let formattingSaves = 0;
let rejectFormatting = false;
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  websocket: {
    message(socket, raw) {
      if (raw === "ping") {
        socket.send("pong");
        return;
      }
      const message = JSON.parse(String(raw));
      if (message.type === "sync")
        socket.send(
          JSON.stringify({
            type: "sync",
            update: encodeSource(Y.encodeStateAsUpdate(doc)),
            vector: encodeSource(Y.encodeStateVector(doc)),
            dirty: true,
            objectKey: null,
            canWrite: true,
            user: { name: "Theme test", color: "#123456" },
          }),
        );
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/formatting") {
      if (rejectFormatting)
        return new Response("Project settings unavailable", { status: 503 });
      const data = (
        await import("../src/lib/project.schema")
      ).updateProjectFormattingSchema.parse(await request.json());
      formattingSaves++;
      project.formatIndent = data.formatting.indent;
      project.formatWrap = data.formatting.wrap;
      project.formatWidth = data.formatting.width;
      return Response.json(data.formatting);
    }
    if (url.pathname.startsWith("/api/collaboration/")) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    }
    if (
      url.pathname === "/fixture/project" ||
      url.pathname.endsWith("/metadata")
    )
      return Response.json(project);
    if (url.searchParams.has("events"))
      return new Response(
        'data: {"revision":0,"current":null,"latestBuild":null,"stale":false,"artifacts":null}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    if (url.searchParams.has("changed"))
      return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  },
});
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const rpc = fileURLToPath(
  new URL("./workspace-upload/rpc.ts", import.meta.url),
);
const vite = await createServer({
  configFile: false,
  root: webRoot,
  optimizeDeps: {
    entries: ["test/workspace-upload/browser.tsx"],
    include: ["react-pdf"],
  },
  plugins: [
    tailwindcss(),
    {
      name: "theme-fixture",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/test/workspace-upload/browser.tsx"></script></body></html>',
          );
        });
      },
    },
  ],
  resolve: {
    alias: {
      "#/lib/project.functions": rpc,
      "#/lib/project-node.functions": rpc,
      "#/lib/project-source.functions": rpc,
      "#/lib/git.functions": rpc,
      "#/lib/project-sharing.functions": rpc,
      "#": `${webRoot}src`,
    },
  },
  server: {
    host: "127.0.0.1",
    port: 0,
    forwardConsole: false,
    proxy: {
      "/fixture": backend.url.href,
      "/api": { target: backend.url.href, ws: true },
    },
  },
});
const browser = await chromium.launch({ headless: true });
const screenshots = fileURLToPath(
  new URL("../../../.audit/nat-310/", import.meta.url),
);
await mkdir(screenshots, { recursive: true });
let debugPage: import("playwright").Page | undefined;
try {
  await vite.listen();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
  });
  debugPage = page;
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const key = appearanceStorageKey("upload-test");
  const stored = () => page.evaluate((key) => localStorage.getItem(key), key);
  const background = () =>
    page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--background"),
    );
  const editorBackground = () =>
    page
      .locator(".cm-editor")
      .first()
      .evaluate((editor) => getComputedStyle(editor).backgroundColor);
  const open = async () => {
    await page.locator('.cm-content[contenteditable="true"]').waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .waitFor()
      .catch(async (error) => {
        console.error(await page.locator("body").innerText());
        throw error;
      });
  };
  const settings = page.getByRole("dialog", {
    name: "Settings",
    exact: true,
  });
  const button = (name: string) =>
    settings.getByRole("button", { name, exact: true });
  const blur = async () => {
    await button("Appearance").focus();
    await button("Appearance").hover();
    const selected = await settings
      .getByRole("group", { name: "Theme", exact: true })
      .locator('button[aria-pressed="true"]')
      .getAttribute("aria-label");
    await page.waitForFunction(
      (name) =>
        document.documentElement.dataset.appTheme ===
        (name === "Follow system appearance" ? "GitHub Light" : name),
      selected,
    );
  };
  const themeName = () =>
    page.evaluate(() => document.documentElement.dataset.appTheme);
  await page.goto(vite.resolvedUrls?.local[0] ?? "");
  await page.locator('.cm-content[contenteditable="true"]').waitFor();
  const original = await stored();
  assert(original);
  const lightBackground = await background();
  await open();
  assert.equal(await settings.count(), 1, "Editor Settings is a dialog");
  const overlay = page.locator('[data-slot="dialog-overlay"]');
  assert.notEqual(
    await overlay.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
    "rgba(0, 0, 0, 0)",
    "Dialog has a dimmed overlay",
  );

  const preferencesKey = "texfolia.settings.v2:upload-test";
  const preferencesStorage = () =>
    page.evaluate((key) => localStorage.getItem(key), preferencesKey);
  const originalPreferences = await preferencesStorage();
  await button("Editor").click();
  const font = settings.getByRole("spinbutton", { name: "Editor font size" });
  await font.fill("");
  await font.pressSequentially("20");
  assert.equal(
    await preferencesStorage(),
    originalPreferences,
    "Editor draft does not persist",
  );
  assert.equal(
    await page
      .locator(".cm-content")
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize),
    "13px",
    "Editor reads committed font until Apply",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Keep editing" })
    .click();
  assert.equal(await font.inputValue(), "20");
  await button("Apply").click();
  assert.equal(
    JSON.parse((await preferencesStorage())!)["s:preferences"].data.editor
      .fontSize,
    20,
  );
  assert.equal(await button("Apply").isDisabled(), true);
  await font.fill("18");
  await overlay.click({ position: { x: 5, y: 5 } });
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard" })
    .click();
  await settings.waitFor({ state: "detached" });
  assert.equal(
    JSON.parse((await preferencesStorage())!)["s:preferences"].data.editor
      .fontSize,
    20,
  );
  await open();
  await button("Keyboard shortcuts").click();
  const recordSidebar = settings.getByRole("button", {
    name: "Record Toggle sidebar",
    exact: true,
  });
  await recordSidebar.click();
  await page.keyboard.press("ControlOrMeta+B");
  await page.keyboard.press("Enter");
  await settings
    .getByRole("alert")
    .filter({ hasText: "Resolve conflicting bindings" })
    .waitFor();
  await button("Apply").click();
  assert.equal(
    JSON.parse((await preferencesStorage())!)["s:preferences"].data.shortcuts
      .sidebar,
    "Mod+Alt+B",
    "Conflicting draft remains uncommitted",
  );
  await settings
    .getByRole("button", { name: "Reset Toggle sidebar", exact: true })
    .click();
  const recordBold = settings.getByRole("button", {
    name: "Record Bold",
    exact: true,
  });
  await recordBold.click();
  await page.keyboard.press("ControlOrMeta+Shift+J");
  await page.keyboard.press("Enter");
  await button("Save").click();
  await settings.waitFor({ state: "detached" });
  await page.locator(".cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+Shift+J");
  assert(
    (await page.locator(".cm-content").first().innerText()).includes(
      "\\textbf{}",
    ),
    "Editor honors remapped Bold",
  );
  await open();
  await button("Appearance").click();

  await settings.getByRole("tab", { name: "Project", exact: true }).click();
  const indent = settings.getByRole("spinbutton", {
    name: "Indent width",
    exact: true,
  });
  await indent.fill("4");
  assert.equal(formattingSaves, 0, "Project draft does not write the server");
  await page.keyboard.press("Escape");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Keep editing" })
    .click();
  await button("Apply").click();
  assert.equal(project.formatIndent, 4);
  assert.equal(formattingSaves, 1);
  assert.equal(await button("Apply").isDisabled(), true);
  await settings
    .getByRole("spinbutton", { name: "Maximum line width", exact: true })
    .fill("100");
  rejectFormatting = true;
  await button("Save").click();
  await settings
    .getByRole("alert")
    .filter({ hasText: "Project settings unavailable" })
    .waitFor();
  assert.equal(
    await settings.count(),
    1,
    "Failed project Save keeps the dialog open",
  );
  assert.equal(project.formatWidth, 80);
  rejectFormatting = false;
  await button("Save").click();
  await settings.waitFor({ state: "detached" });
  assert.equal(project.formatWidth, 100);
  await open();
  await button("Dracula").hover();
  await page.waitForFunction(
    () => document.documentElement.dataset.appTheme === "Dracula",
  );
  assert.equal(await background(), "#282a36");
  assert.equal(await editorBackground(), "rgb(40, 42, 54)");
  assert.equal(await stored(), original, "Hover never persists");
  await blur();
  assert.equal(
    await background(),
    lightBackground,
    "Leaving hover restores committed theme",
  );
  await button("Nord").focus();
  await page.waitForFunction(
    () => document.documentElement.dataset.appTheme === "Nord",
  );
  assert.equal(await stored(), original, "Keyboard focus never persists");
  await blur();
  assert.equal(await background(), lightBackground);
  await button("Dracula").click();
  await blur();
  assert.equal(await themeName(), "Dracula", "Click selects a live draft");
  assert.equal(await stored(), original, "Click never persists");
  await button("Nord").hover();
  await blur();
  assert.equal(
    await themeName(),
    "Dracula",
    "Leaving preview restores current draft",
  );
  await button("Keyboard shortcuts").click();
  await settings
    .getByRole("heading", { name: "Keyboard shortcuts", exact: true })
    .waitFor();
  await button("Appearance").click();
  assert.equal(await button("Dracula").getAttribute("aria-pressed"), "true");
  await button("Apply").click();
  assert.equal(JSON.parse((await stored())!).selection.id, "dracula");
  assert.equal(await settings.count(), 1, "Apply keeps panel open");
  assert.equal(
    await button("Apply").isDisabled(),
    true,
    "Apply clears dirty state",
  );
  const applied = await stored();
  // A failed save keeps the draft available for retry.
  await page.evaluate((key) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (storageKey, value) {
      if (storageKey === key) throw new Error("Storage full");
      return setItem.call(this, storageKey, value);
    };
  }, key);
  await button("Nord").click();
  await button("Save").click();
  await settings
    .getByRole("alert")
    .filter({ hasText: "Appearance could not be saved" })
    .first()
    .waitFor();
  assert.equal(await button("Apply").isEnabled(), true);
  assert.equal(await stored(), applied);
  await button("Cancel").click();
  await settings.waitFor({ state: "detached" });
  await page.reload();
  await page.locator('.cm-content[contenteditable="true"]').waitFor();
  await open();

  await button("Nord").click();
  await button("Cancel").click();
  await settings.waitFor({ state: "detached" });
  assert.equal(await themeName(), "Dracula");
  assert.equal(
    await stored(),
    applied,
    "Cancel preserves the committed appearance",
  );
  await open();
  await button("Nord").click();
  const close = settings.getByRole("button", { name: "Close", exact: true });
  await close.click();
  const guard = page.getByRole("alertdialog");
  await guard.waitFor();
  await guard
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await guard.waitFor({ state: "detached" });
  await close.click();
  await guard.getByRole("button", { name: "Apply", exact: true }).click();
  await guard.waitFor({ state: "detached" });
  assert.equal(
    await settings.count(),
    1,
    "Close-guard Apply keeps Settings open",
  );
  assert.equal(await button("Apply").isDisabled(), true);
  assert.equal(JSON.parse((await stored())!).selection.id, "nord");
  await button("Dracula").click();
  await close.click();
  await guard.getByRole("button", { name: "Discard", exact: true }).click();
  await settings.waitFor({ state: "detached" });
  assert.equal(await themeName(), "Nord");
  await open();
  await button("Dracula").click();
  await button("Save").click();
  await settings.waitFor({ state: "detached" });
  assert.equal(JSON.parse((await stored())!).selection.id, "dracula");
  await page.reload();
  await page.locator('.cm-content[contenteditable="true"]').waitFor();
  assert.equal(await themeName(), "Dracula", "Saved selection survives reload");
  await open();
  await blur();
  // Dialogs are transient and reopen cleanly after reload.
  await page.reload();
  await open();
  await blur();
  await page.screenshot({ path: `${screenshots}/settings-dark.png` });
  await button("GitHub Light").hover();
  await page.screenshot({ path: `${screenshots}/settings-light-preview.png` });
  await button("Cancel").click();
  await settings.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await blur();
  assert(
    await settings.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
    "Settings fits narrow workspace",
  );
  await page.screenshot({ path: `${screenshots}/settings-mobile.png` });
  await button("Cancel").click();
  await settings.waitFor({ state: "detached" });
  // Migrate the real provider, preserving PDF mode and discarding old cached colors.
  await page.evaluate(
    ({ key, legacyKey }) => {
      localStorage.removeItem(key);
      localStorage.setItem(
        legacyKey,
        JSON.stringify({
          selection: {
            kind: "imported",
            theme: { colors: { "editor.background": "#123456" } },
          },
          pdfMode: "match",
        }),
      );
    },
    { key, legacyKey: legacyAppearanceStorageKey("upload-test") },
  );
  await page.reload();
  await page.locator('.cm-content[contenteditable="true"]').waitFor();
  assert.equal(await background(), lightBackground);
  assert.deepEqual(JSON.parse((await stored())!).selection, { kind: "system" });
  assert.equal(JSON.parse((await stored())!).pdfMode, "match");

  await page.evaluate(() =>
    localStorage.setItem("texfolia.settings.v2:upload-test", "{broken"),
  );
  await page.reload();
  await open();
  await button("Editor").click();
  assert.equal(
    await settings
      .getByRole("spinbutton", { name: "Editor font size" })
      .isDisabled(),
    true,
    "Unavailable browser storage disables only its own fields",
  );
  await settings.getByRole("tab", { name: "Project", exact: true }).click();
  await settings
    .getByRole("spinbutton", { name: "Indent width", exact: true })
    .fill("6");
  await button("Apply").click();
  assert.equal(
    project.formatIndent,
    6,
    "Browser preference load failure does not block project saves",
  );
  await button("Cancel").click();
  await settings.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.info(
    "Settings/theme UI passed: dialog, editor drafts, shortcut recording/conflicts/remapping, hover/focus, editor and workspace preview, draft restoration, Apply/Save/Cancel, Esc/overlay/X close guards, reload, migration, and narrow layout",
  );
} catch (error) {
  console.error(await debugPage?.locator("body").innerText());
  await debugPage?.screenshot({ path: `${screenshots}/failure.png` });
  throw error;
} finally {
  await browser.close();
  await vite.close();
  backend.stop(true);
  doc.destroy();
}
