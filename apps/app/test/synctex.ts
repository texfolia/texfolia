import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";
import { createServer } from "vite";
import * as Y from "yjs";

import { decodeClientMessage, encodeServerMessage } from "#/lib/collaboration";
import { hashSource } from "#/lib/compile";

import type { ProjectDetails } from "../src/lib/projects/project.functions";

const fixture = new URL("./fixtures/synctex/", import.meta.url);
const pdf = await Bun.file(new URL("main.pdf", fixture)).arrayBuffer();
const map = await Bun.file(new URL("main.synctex", fixture)).text();
const projectId = crypto.randomUUID();
const rootId = crypto.randomUUID();
const mainId = crypto.randomUUID();
const chaptersId = crypto.randomUUID();
const appendicesId = crypto.randomUUID();
const chapterId = crypto.randomUUID();
const appendixId = crypto.randomUUID();
const project: ProjectDetails = {
  id: projectId,
  ownerId: "upload-test",
  organizationId: null,
  name: "SyncTeX regression",
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
    {
      id: chaptersId,
      projectId,
      parentId: rootId,
      name: "chapters",
      kind: "folder",
    },
    {
      id: appendicesId,
      projectId,
      parentId: rootId,
      name: "appendices",
      kind: "folder",
    },
    {
      id: chapterId,
      projectId,
      parentId: chaptersId,
      name: "one.tex",
      kind: "text",
    },
    {
      id: appendixId,
      projectId,
      parentId: appendicesId,
      name: "one.tex",
      kind: "text",
    },
  ],
  sourceContents: {},
  sourceVersions: {},
};
const documents = new Map<string, Y.Doc>();
const persisted = new Map<
  string,
  { dirty: boolean; objectKey: string | null }
>();
const saveRequests: { nodeId: string }[] = [];
for (const [id, path] of [
  [mainId, "main.tex"],
  [chapterId, "chapters/one.tex"],
  [appendixId, "appendices/one.tex"],
]) {
  assert(id && path);
  const value = await Bun.file(new URL(path, fixture)).text();
  project.sourceContents[id] = value;
  project.sourceVersions[id] = { objectKey: null, updatedAt: 0 };
  const doc = new Y.Doc();
  doc.getText("source").insert(0, value);
  documents.set(id, doc);
  persisted.set(id, { dirty: false, objectKey: null });
}
let buildId: string = crypto.randomUUID();
let revision = 1;
let running = false;
type SidecarMode = "gzip" | "plain" | "missing" | "corrupt" | "unavailable";
let sidecar: SidecarMode = "gzip";
let savedId = buildId;
let previewRequested = false;
const requestedMaps = new Set<SidecarMode>();
const subscribers = new Set<{ send(data: string): unknown }>();
function snapshot() {
  return {
    revision,
    current: {
      id: buildId,
      revision,
      status: running ? "running" : "succeeded",
    },
    latestBuild: {
      id: savedId,
      revision: running ? revision - 1 : revision,
      status: "succeeded",
    },
    stale: running,
    artifacts: {
      id: savedId,
      revision: running ? revision - 1 : revision,
      digest: savedId,
      builtAt: new Date().toISOString(),
      builtBy: "fixture",
      engine: "xetex",
      pdf: "main.pdf",
      files: [
        {
          path: "main.pdf",
          key: `${savedId}/main.pdf`,
          sizeBytes: pdf.byteLength,
        },
        ...(sidecar === "missing"
          ? []
          : [
              {
                path: sidecar === "plain" ? "main.synctex" : "main.synctex.gz",
                key: `${savedId}/map`,
                sizeBytes: map.length,
              },
            ]),
      ],
    },
  };
}
function event() {
  return JSON.stringify(snapshot());
}
function publish() {
  for (const subscriber of subscribers) subscriber.send(event());
}
function nextBuild(mode: SidecarMode) {
  buildId = crypto.randomUUID();
  savedId = buildId;
  revision++;
  sidecar = mode;
  running = false;
  publish();
}
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 120,
  websocket: {
    data: { nodeId: "", events: false },
    open(socket) {
      if (!socket.data.events) return;
      subscribers.add(socket);
      socket.send(event());
    },
    close(socket) {
      subscribers.delete(socket);
    },
    async message(socket, raw) {
      if (raw === "ping") {
        socket.send("pong");
        return;
      }
      const message = decodeClientMessage(raw);
      const doc = documents.get(socket.data.nodeId);
      const state = persisted.get(socket.data.nodeId);
      assert(doc && state);
      if (message.type === "sync")
        socket.send(
          encodeServerMessage({
            type: "sync",
            update: Y.encodeStateAsUpdate(doc),
            vector: Y.encodeStateVector(doc),
            ...state,
            canWrite: true,
            user: { name: "SyncTeX test", color: "#123456" },
          }),
        );
      if (message.type === "update") {
        Y.applyUpdate(doc, message.update);
        state.dirty = true;
      }
      if (message.type === "save") {
        saveRequests.push({ nodeId: socket.data.nodeId });
        const value = doc.getText("source").toString();
        const objectKey = `projects/${projectId}/sources/${await hashSource(new TextEncoder().encode(value))}`;
        const updatedAt = Date.now();
        project.sourceVersions[socket.data.nodeId] = { objectKey, updatedAt };
        Object.assign(state, { dirty: false, objectKey });
        socket.send(
          JSON.stringify({
            type: "saved",
            id: message.id,
            value,
            objectKey,
            updatedAt,
          }),
        );
      }
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/collaboration/")) {
      if (
        server.upgrade(request, {
          data: {
            nodeId: url.pathname.split("/").at(-1) ?? "",
            events: false,
          },
        })
      )
        return;
      return new Response(null, { status: 400 });
    }
    if (
      url.pathname === "/fixture/project" ||
      url.pathname.endsWith("/metadata")
    )
      return Response.json(project);
    if (url.searchParams.has("events")) {
      return server.upgrade(request, { data: { nodeId: "", events: true } })
        ? undefined
        : new Response(null, { status: 426 });
    }
    if (url.pathname === "/fixture/preview.pdf") {
      previewRequested = true;
      return new Response(pdf, {
        headers: { "Content-Type": "application/pdf" },
      });
    }
    if (url.pathname === "/fixture/status")
      return Response.json({
        id: buildId,
        revision,
        status: running ? "running" : "succeeded",
        artifactUrl: "/fixture/preview.pdf",
        log: "",
      });
    if (
      url.pathname === `/api/compile/${projectId}` &&
      !url.searchParams.has("changed") &&
      request.method === "POST"
    ) {
      buildId = request.headers.get("X-Compilation-Id") ?? crypto.randomUUID();
      revision++;
      running = true;
      previewRequested = false;
      publish();
      return Response.json({
        id: buildId,
        revision,
        statusUrl: "/fixture/status",
        previewUrl: "/fixture/preview.pdf",
      });
    }
    if (url.searchParams.has("file")) {
      if (url.searchParams.get("file") === "main.pdf")
        return new Response(pdf, {
          headers: { "Content-Type": "application/pdf" },
        });
      requestedMaps.add(sidecar);
      if (sidecar === "unavailable") return new Response(null, { status: 503 });
      return new Response(
        sidecar === "corrupt"
          ? "broken map"
          : sidecar === "plain"
            ? map
            : Bun.gzipSync(map),
      );
    }
    if (request.method === "PATCH" || url.searchParams.has("changed"))
      return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  },
});
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const rpc = fileURLToPath(
  new URL("./workspace-upload/rpc.ts", import.meta.url),
);
// Reuse the real workspace boot and unrelated RPC stubs from the upload harness.
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
      name: "synctex-fixture",
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
      "#/lib/projects/project.functions": rpc,
      "#/lib/projects/project-node.functions": rpc,
      "#/lib/projects/project-source.functions": rpc,
      "#/lib/git/git.functions": rpc,
      "#/lib/sharing/project-sharing.functions": rpc,
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
try {
  await vite.listen();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(vite.resolvedUrls?.local[0] ?? "");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const hint = page.getByText("Cmd/Ctrl-click the PDF", { exact: false });
  const editor = page.locator('.cm-content[contenteditable="true"]:visible');
  await editor.waitFor();
  console.info("Saved artifact: source click opens the right PDF page");
  await page.getByRole("button", { name: "main.pdf", exact: true }).click();
  await hint.waitFor();
  await page.getByRole("tab", { name: "main.tex", exact: true }).click();
  await editor
    .locator(".cm-line")
    .filter({ hasText: "Second page source." })
    .click({ modifiers: [modifier] });
  await page.getByLabel("Source location in PDF").waitFor();
  assert.equal(
    await page.getByRole("spinbutton", { name: "Page number" }).inputValue(),
    "2",
  );
  const text = page
    .locator(".react-pdf__Page__textContent span")
    .filter({ hasText: "Chapter two belongs" });
  await text.waitFor();
  await text.click();
  assert.equal(
    await editor.count(),
    0,
    "Ordinary PDF clicks must preserve the preview",
  );
  await text.click({ modifiers: [modifier] });
  await editor.filter({ hasText: "Chapter two belongs" }).waitFor();
  assert(
    !(await editor.innerText()).includes("Chapter one"),
    "Same-named files must resolve by full path",
  );
  console.info("Source → PDF → source after zoom and all rotations");
  for (let turn = 0; turn < 4; turn++) {
    await editor
      .locator(".cm-line")
      .filter({ hasText: "Chapter two belongs" })
      .click({ modifiers: [modifier] });
    await hint.waitFor();
    if (turn) {
      await page.getByRole("button", { name: "More PDF actions" }).click();
      await page.getByRole("menuitem", { name: "Rotate clockwise" }).click();
    }
    if (turn === 1) {
      await page.getByRole("button", { name: "More PDF actions" }).click();
      await page.getByRole("menuitem", { name: "Zoom in" }).click();
    }
    await text.click({ modifiers: [modifier] });
    await editor.filter({ hasText: "Chapter two belongs" }).waitFor();
  }
  await editor
    .locator(".cm-line")
    .filter({ hasText: "Chapter two belongs" })
    .click({ modifiers: [modifier] });
  await hint.waitFor();
  await page.screenshot({ path: "/tmp/texfolia-nat321-preview.png" });
  await page.reload();
  await hint.waitFor();
  await page.getByRole("spinbutton", { name: "Page number" }).fill("2");
  await page.getByRole("spinbutton", { name: "Page number" }).press("Enter");
  await text.waitFor();
  await text.click({ modifiers: [modifier] });
  await editor.filter({ hasText: "Chapter two belongs" }).waitFor();
  console.info("Local edits disable both directions until recompile");
  await editor
    .locator(".cm-line")
    .filter({ hasText: "Chapter two belongs" })
    .click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ");
  await editor
    .locator(".cm-line")
    .filter({ hasText: "Chapter two belongs" })
    .click({ modifiers: [modifier] });
  assert.equal(
    await editor.count(),
    1,
    "Stale source must not navigate to the PDF",
  );
  await page.getByRole("tab", { name: "main.pdf", exact: true }).click();
  await hint.waitFor({ state: "hidden" });
  await text.click({ modifiers: [modifier] });
  assert.equal(await editor.count(), 0);
  console.info(
    "Streamed PDF waits for its own sidecar, then enables navigation",
  );
  const previewResponse = page.waitForResponse((response) =>
    response.url().includes("/fixture/preview.pdf"),
  );
  const savesBefore = saveRequests.length;
  await page
    .getByRole("button", { name: "Compile status", exact: true })
    .click();
  await previewResponse;
  assert.deepEqual(
    saveRequests.slice(savesBefore),
    [{ nodeId: chapterId }],
    "Saving sends one payload-free request for the one edited file",
  );
  assert(previewRequested);
  await hint.waitFor({ state: "hidden" });
  running = false;
  savedId = buildId;
  publish();
  await hint.waitFor();
  await page.getByRole("spinbutton", { name: "Page number" }).fill("2");
  await page.getByRole("spinbutton", { name: "Page number" }).press("Enter");
  await text.click({ modifiers: [modifier] });
  await editor.filter({ hasText: "Chapter two belongs" }).waitFor();
  console.info("Plain sidecar and missing/corrupt maps preserve PDF controls");
  const plainResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get("file") === "main.synctex",
  );
  nextBuild("plain");
  await page.getByRole("tab", { name: "main.pdf", exact: true }).click();
  await hint.waitFor();
  await plainResponse;
  await hint.waitFor();
  await page.getByRole("spinbutton", { name: "Page number" }).fill("2");
  await page.getByRole("spinbutton", { name: "Page number" }).press("Enter");
  await text.waitFor();
  await page.screenshot({ path: "/tmp/texfolia-nat321-preview.png" });
  await page.setViewportSize({ width: 900, height: 780 });
  await page.screenshot({ path: "/tmp/texfolia-nat321-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await text.click({ modifiers: [modifier] });
  await editor.filter({ hasText: "Chapter two belongs" }).waitFor();
  await editor
    .locator(".cm-line")
    .filter({ hasText: "Chapter two belongs" })
    .click({ modifiers: [modifier] });
  await hint.waitFor();
  for (const mode of [
    "missing",
    "corrupt",
    "unavailable",
  ] satisfies SidecarMode[]) {
    const previousCanvas = await page
      .locator(".react-pdf__Page__canvas")
      .elementHandle();
    assert(previousCanvas);
    nextBuild(mode);
    await hint.waitFor({ state: "hidden" });
    await page.waitForFunction((canvas) => !canvas.isConnected, previousCanvas);
    await page.locator(".react-pdf__Page__canvas").waitFor();
    const input = page.getByRole("spinbutton", { name: "Page number" });
    await input.fill("1");
    await input.press("Enter");
    assert.equal(await input.inputValue(), "1");
    await page.getByRole("button", { name: "Next page" }).click();
    assert.equal(await input.inputValue(), "2");
    await page.getByRole("button", { name: "More PDF actions" }).click();
    await page.getByRole("menuitem", { name: "Rotate clockwise" }).click();
    await page.getByRole("button", { name: "Fit to width" }).click();
    await page.getByRole("button", { name: "More PDF actions" }).click();
    const download = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Download PDF", exact: true })
      .click();
    assert.equal((await download).suggestedFilename(), "main.pdf");
  }
  await page.screenshot({ path: "/tmp/texfolia-nat321-no-map.png" });
  assert.deepEqual([...requestedMaps].sort(), [
    "corrupt",
    "gzip",
    "plain",
    "unavailable",
  ]);
  assert.deepEqual(errors, []);
  console.info("SyncTeX workspace navigation and preview fallbacks passed.");
} finally {
  await browser.close();
  await vite.close();
  backend.stop(true);
  for (const doc of documents.values()) doc.destroy();
}
