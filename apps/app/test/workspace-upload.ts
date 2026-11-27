import assert from "node:assert/strict";

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
import { compileDeltaSchema, hashSource } from "#/lib/compile";
import {
  createNodeSchema,
  renameNodeSchema,
  renamedProjectNodes,
} from "#/lib/projects";
import { decodeSource } from "#/lib/storage";

import {
  compileOnEngine,
  type Files,
} from "../../compiler/scripts/engine-client";
import type { ProjectDetails } from "../src/lib/projects/project.functions";
import { createWorkspaceServer } from "./editor-runtime/workspace-server";
import type { UploadTest } from "./workspace-upload/browser";

declare global {
  interface Window {
    uploadTest: UploadTest;
  }
}

const engineUrl = process.env.ENGINE_URL;
assert(engineUrl, "Set ENGINE_URL to a local Tectonic engine");
const projectId = crypto.randomUUID();
const rootId = crypto.randomUUID();
const mainId = crypto.randomUUID();
const main = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
Uploaded binary without reload: \includegraphics[width=1cm]{image.png}
\end{document}`;
const project: ProjectDetails = {
  id: projectId,
  ownerId: "upload-test",
  organizationId: null,
  name: "Binary upload regression",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  formatIndent: 2,
  formatWrap: true,
  formatWidth: 80,
  spellcheckLanguage: "en-US",
  mainFile: null,
  organizationRole: null,
  role: "editor",
  canWrite: true,
  canComment: true,
  nodes: [
    { id: rootId, projectId, parentId: null, name: "root", kind: "folder" },
    { id: mainId, projectId, parentId: rootId, name: "main.tex", kind: "text" },
  ],
  sourceContents: { [mainId]: main },
  commentsVersion: "0:0",
  gitVersion: "",
  sourceVersions: { [mainId]: { objectKey: null, updatedAt: 0 } },
};
const documents = new Map<string, Y.Doc>();
const sourceObjects = new Map<string, Uint8Array>();
const mainDoc = new Y.Doc();
mainDoc.getText("source").insert(0, main);
documents.set(mainId, mainDoc);
const submissions: Array<ReturnType<typeof compileDeltaSchema.parse>> = [];
let failUpload = true;
let failCompile = true;
let pdf: Blob | null = null;
let jobId = "";
const subscribers = new Set<{ send(data: string): unknown }>();
function snapshot() {
  const build = jobId ? { id: jobId, revision: 1, status: "succeeded" } : null;
  return {
    revision: jobId ? 1 : 0,
    current: build,
    latestBuild: build,
    stale: false,
    artifacts: pdf
      ? {
          id: jobId,
          revision: 1,
          digest: "upload-test",
          builtAt: new Date().toISOString(),
          builtBy: "upload-test",
          engine: "tectonic",
          pdf: "output.pdf",
          files: [{ path: "output.pdf", key: jobId, sizeBytes: pdf.size }],
        }
      : null,
  };
}
function event() {
  return JSON.stringify(snapshot());
}

// The network boundary is a fixture; React, upload, collection, collaboration
// client, workspace, compile transport, Tectonic, and PDF.js all run for real.
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 120,
  websocket: {
    data: { nodeId: "", events: false, multiplex: false },
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
      if (socket.data.multiplex) {
        const message = decodeMultiplexClientMessage(raw);
        if (message.type === "close") return;
        const { nodeId } = message;
        const doc = documents.get(nodeId);
        assert(doc);
        if (message.type === "sync")
          socket.send(
            encodeMultiplexServerMessage({
              type: "sync",
              nodeId,
              update: Y.encodeStateAsUpdate(doc),
              vector: Y.encodeStateVector(doc),
              dirty: true,
              objectKey: null,
              canWrite: true,
              user: { name: "Upload test", color: "#123456" },
            }),
          );
        if (message.type === "update") Y.applyUpdate(doc, message.update);
        if (message.type === "save") {
          const value = doc.getText("source").toString();
          const bytes = new TextEncoder().encode(value);
          const hash = await hashSource(bytes);
          sourceObjects.set(hash, bytes);
          project.sourceVersions[nodeId] = {
            objectKey: `projects/${projectId}/sources/${hash}`,
            updatedAt: Date.now(),
          };
          socket.send(
            encodeMultiplexServerMessage({
              type: "saved",
              nodeId,
              id: message.id,
              value,
              objectKey: `projects/${projectId}/sources/${hash}`,
              updatedAt: Date.now(),
            }),
          );
        }
        return;
      }
      const message = decodeClientMessage(raw);
      const doc = documents.get(socket.data.nodeId);
      assert(doc);
      if (message.type === "sync")
        socket.send(
          encodeServerMessage({
            type: "sync",
            update: Y.encodeStateAsUpdate(doc),
            vector: Y.encodeStateVector(doc),
            dirty: true,
            objectKey: null,
            canWrite: true,
            user: { name: "Upload test", color: "#123456" },
          }),
        );
      if (message.type === "update") Y.applyUpdate(doc, message.update);
      if (message.type === "save") {
        const value = doc.getText("source").toString();
        const bytes = new TextEncoder().encode(value);
        const hash = await hashSource(bytes);
        sourceObjects.set(hash, bytes);
        project.sourceVersions[socket.data.nodeId] = {
          objectKey: `projects/${projectId}/sources/${hash}`,
          updatedAt: Date.now(),
        };
        socket.send(
          JSON.stringify({
            type: "saved",
            id: message.id,
            value,
            objectKey: `projects/${projectId}/sources/${hash}`,
            updatedAt: Date.now(),
          }),
        );
      }
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/collaboration/")) {
      const multiplex =
        url.searchParams.get(protocolSearchParam) ===
        multiplexCollaborationProtocol;
      if (
        server.upgrade(request, {
          data: {
            nodeId: multiplex ? "" : (url.pathname.split("/").at(-1) ?? ""),
            events: false,
            multiplex,
          },
        })
      )
        return;
      return new Response(null, { status: 400 });
    }
    if (url.pathname === "/fixture/project") return Response.json(project);
    if (url.pathname === `/api/projects/${projectId}/metadata`)
      return Response.json(project);
    if (url.pathname === "/fixture/rename") {
      const data = renameNodeSchema.parse(await request.json());
      renamedProjectNodes(project.nodes, data.nodeId, data.name, data.parentId);
      const node = project.nodes.find((node) => node.id === data.nodeId);
      assert(node);
      node.name = data.name;
      node.parentId = data.parentId;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/fixture/nodes") {
      const input = createNodeSchema.parse(await request.json());
      if (failUpload) {
        failUpload = false;
        return new Response("Upload unavailable", { status: 503 });
      }
      const bytes = decodeSource(input.content ?? "");
      const hash = await hashSource(bytes);
      sourceObjects.set(hash, bytes);
      if (input.kind === "text") {
        const doc = new Y.Doc();
        doc.getText("source").insert(0, new TextDecoder().decode(bytes));
        documents.set(input.id, doc);
      }
      const sourceVersion = {
        objectKey:
          input.content === undefined
            ? null
            : `projects/${projectId}/sources/${hash}`,
        updatedAt: Date.now(),
      };
      project.nodes.push(input);
      if (input.kind !== "folder")
        project.sourceVersions[input.id] = sourceVersion;
      return Response.json({ ...input, sourceVersion });
    }

    if (url.pathname.startsWith(`/api/sources/${projectId}/`)) {
      const version =
        project.sourceVersions[url.pathname.split("/").at(-1) ?? ""];
      const hash = version?.objectKey?.split("/").at(-1);
      const bytes = hash ? sourceObjects.get(hash) : undefined;
      return bytes
        ? new Response(new Uint8Array(bytes))
        : new Response(null, { status: 404 });
    }
    if (url.searchParams.has("events")) {
      return server.upgrade(request, {
        data: { nodeId: "", events: true, multiplex: false },
      })
        ? undefined
        : new Response(null, { status: 426 });
    }
    if (request.method === "PATCH") return new Response(null, { status: 204 });
    if (url.searchParams.has("changed"))
      return new Response(null, { status: 204 });
    if (url.searchParams.has("file"))
      return new Response(pdf, {
        headers: { "Content-Type": "application/pdf" },
      });
    if (request.method === "POST") {
      const delta = compileDeltaSchema.parse(await request.json());
      submissions.push(delta);
      if (failCompile) {
        failCompile = false;
        return Response.json(
          { error: "Compiler unavailable" },
          { status: 503 },
        );
      }
      const files: Files = {};
      for (const [path, source] of Object.entries(delta.files)) {
        if (path.endsWith(".png")) {
          assert.deepEqual(
            Object.keys(source).sort(),
            ["hash", "key"],
            "Binary compile transport must reference only its saved hash and key",
          );
          const bytes = sourceObjects.get(source.hash);
          assert(bytes, "Compile referenced an unacknowledged object");
          files[path] = new Uint8Array(bytes);
        } else {
          const bytes = sourceObjects.get(source.hash);
          assert(source.content !== undefined || bytes);
          const { content } = source;
          assert(typeof content !== "object", "Text is sent as text");
          files[path] = content ?? new TextDecoder().decode(bytes);
        }
      }
      jobId = request.headers.get("X-Compilation-Id") ?? "";
      const output = await compileOnEngine(
        { mainFile: delta.mainFile, files },
        engineUrl,
      );
      assert(output.pdf, output.result.error);
      pdf = new Blob([output.pdf]);
      for (const subscriber of subscribers) subscriber.send(event());
      return Response.json({
        id: jobId,
        revision: 1,
        statusUrl: `/api/status/${jobId}`,
      });
    }
    if (url.pathname.startsWith("/api/status/"))
      return Response.json({
        id: jobId,
        revision: 1,
        status: "succeeded",
        artifactUrl: "/api/output.pdf",
        log: "",
      });
    if (url.pathname === "/api/output.pdf")
      return new Response(pdf, {
        headers: { "Content-Type": "application/pdf" },
      });
    return new Response(null, { status: 404 });
  },
});
const vite = await createWorkspaceServer({
  entry: "workspace-upload",
  backend: backend.url,
});
const browser = await chromium.launch({ headless: true });
try {
  await vite.listen();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error);
  });
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.goto(vite.resolvedUrls?.local[0] ?? "");
  async function fileMenu(item: string) {
    await page
      .locator('[data-slot="menubar-trigger"]')
      .filter({ hasText: /^File$/ })
      .click();
    await page.getByRole("menuitem", { name: item, exact: true }).focus();
    await page.keyboard.press("Enter");
  }
  console.info("Checking workspace initialization");
  await page
    .locator('.cm-content[contenteditable="true"]')
    .waitFor()
    .catch(async (error) => {
      console.error(await page.locator("body").innerText());
      throw error;
    });
  console.info("Checking source name validation before any upload is stored");
  await fileMenu("New file");
  await page.getByLabel("File name", { exact: true }).fill("chapter:1.tex");
  await page.getByRole("button", { name: "Create file", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "colons" }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const name of ["chapter:1.tex", "a".repeat(241), "é".repeat(121)]) {
    await page.getByLabel("Upload project source").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from("not stored"),
    });
    await page
      .getByRole("alert")
      .filter({ hasText: name.includes(":") ? "colons" : "240 UTF-8 bytes" })
      .waitFor();
    assert.equal(project.nodes.length, 2);
    assert.equal(sourceObjects.size, 0);
  }
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing canvas context");
    context.fillStyle = "#1357ac";
    context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });
  const image = {
    name: "image.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  };
  await page.getByLabel("Upload project source").setInputFiles(image);
  console.info("Checking failed upload rollback");
  await page
    .getByRole("alert")
    .filter({ hasText: "Upload unavailable" })
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      window.uploadTest.nodes().some((node) => node.name === "image.png"),
    ),
    false,
    "Failed upload must roll back",
  );
  assert.deepEqual(
    await page.evaluate(() => Object.keys(window.uploadTest.versions())),
    [mainId],
    "Failed upload must not leave a source version",
  );
  await page.getByLabel("Upload project source").setInputFiles(image);
  console.info("Checking binary upload acknowledgment");
  await page.getByRole("img", { name: "image.png", exact: true }).waitFor();
  const unopened = await page.evaluate(
    ({ rootId, png }) =>
      window.uploadTest.create({
        parentId: rootId,
        name: "unopened.png",
        kind: "binary",
        content: png,
      }),
    { rootId, png },
  );
  assert.equal(
    await page.getByRole("tab", { name: "unopened.png" }).count(),
    0,
  );
  assert.equal(
    (await page.evaluate(() => Object.keys(window.uploadTest.versions())))
      .length,
    3,
    "Both opened and unopened uploads retain their acknowledged version",
  );
  assert.deepEqual(
    await page.evaluate(() =>
      Object.keys(window.uploadTest.snapshotVersions()),
    ),
    [mainId],
    "Store changes must not mutate the route snapshot",
  );
  assert.match(
    await page.evaluate(async (id) => {
      try {
        await window.uploadTest.remove(id);
        return "Unexpected success";
      } catch (error) {
        return String(error);
      }
    }, unopened.id),
    /Delete unavailable/,
  );
  assert.equal(
    await page.evaluate(
      (id) => window.uploadTest.nodes().some((node) => node.id === id),
      unopened.id,
    ),
    true,
    "Failed deletion must roll back",
  );
  assert.match(
    await page.evaluate(async (id) => {
      try {
        await window.uploadTest.remove(id);
        return "Unexpected success";
      } catch (error) {
        return String(error);
      }
    }, mainId),
    /Delete unavailable/,
  );
  assert.equal(
    await page
      .getByText(
        "This file was deleted. Your local text is still available to copy.",
      )
      .count(),
    0,
    "Rejected optimistic deletion must leave the collaborative editor connected",
  );
  await page.getByRole("button", { name: /^Compile status:/ }).click();
  console.info("Checking compile submission");
  await page
    .getByRole("alert")
    .filter({ hasText: /compiler/i })
    .waitFor();
  assert.equal(
    submissions.length,
    1,
    "Acknowledged binary hash must reach the workspace compile request",
  );
  assert.equal(
    await page
      .getByRole("alert")
      .filter({ hasText: /compiler/i })
      .innerText(),
    "Compiler unavailable",
  );
  await page.getByRole("button", { name: /^Compile status:/ }).click();
  await page.getByRole("button", { name: "output.pdf", exact: true }).click();
  await page
    .locator(".react-pdf__Page__canvas")
    .waitFor()
    .catch(async (error) => {
      console.error(await page.locator("body").innerText());
      throw error;
    });
  await page
    .locator(".react-pdf__Page__textContent")
    .getByText(/Uploaded binary without reload/)
    .waitFor();
  assert.equal(submissions.length, 2);
  assert.deepEqual(
    submissions[1],
    submissions[0],
    "Rejected compile must resend the full delta",
  );
  assert.deepEqual(Object.keys(submissions[1]?.files ?? {}).sort(), [
    "image.png",
    "main.tex",
    "unopened.png",
  ]);
  const created = await page.evaluate(async (rootId) => {
    const text = await window.uploadTest.create({
      parentId: rootId,
      name: "notes.txt",
      kind: "text",
      content: btoa("acknowledged text"),
    });
    const empty = await window.uploadTest.create({
      parentId: rootId,
      name: "empty.tex",
      kind: "text",
    });
    const folder = await window.uploadTest.create({
      parentId: rootId,
      name: "figures",
      kind: "folder",
    });
    return {
      text,
      empty,
      folder,
      versions: window.uploadTest.versions(),
      contents: window.uploadTest.textSources(),
    };
  }, rootId);
  assert(created.versions[created.text.id]?.objectKey);
  assert.deepEqual(created.versions[created.empty.id]?.objectKey, null);
  assert.equal(created.contents[created.text.id], "acknowledged text");
  assert.equal(created.contents[created.empty.id], "");
  assert.equal(created.versions[created.folder.id], undefined);
  assert.equal(
    navigations,
    1,
    "Upload through PDF must not navigate or reload",
  );
  console.info("Checking legacy path recovery through the workspace form");
  const legacyId = crypto.randomUUID();
  const legacyDoc = new Y.Doc();
  legacyDoc.getText("source").insert(0, "legacy source preserved");
  documents.set(legacyId, legacyDoc);
  project.nodes.push({
    id: legacyId,
    projectId,
    parentId: rootId,
    name: "chapter:1.tex",
    kind: "text",
  });
  project.sourceVersions[legacyId] = { objectKey: null, updatedAt: 0 };
  await page.evaluate(() => window.uploadTest.refresh());
  await page
    .getByRole("button", { name: "chapter:1.tex", exact: true })
    .click();
  await page.getByRole("tab", { name: /^chapter:1\.tex/ }).waitFor();
  await page.getByRole("button", { name: /^Compile status:/ }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /chapter:1.tex.*Repair source paths/ })
    .waitFor();
  assert.equal(
    submissions.length,
    2,
    "Invalid legacy path must not reach the compiler",
  );
  const download = page.waitForEvent("download");
  await fileMenu("Export project");
  await page.getByRole("button", { name: "Download zip", exact: true }).click();
  assert.match((await download).suggestedFilename(), /\.zip$/);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await fileMenu("Repair source paths");
  const repair = page.getByRole("dialog", { name: "Repair source paths" });
  await repair.getByText("These paths prevent compilation:").waitFor();

  await repair
    .getByLabel("File or folder", { exact: true })
    .selectOption(legacyId);
  await repair.getByLabel("New name", { exact: true }).fill("recovered.tex");
  await repair
    .getByLabel("In folder", { exact: true })
    .selectOption(created.folder.id);
  if (process.env.WORKSPACE_TEST_SCREENSHOT)
    await page.screenshot({
      path: process.env.WORKSPACE_TEST_SCREENSHOT,
      fullPage: true,
    });
  await repair.getByRole("button", { name: "Rename", exact: true }).click();
  await page
    .getByText("Repair source paths", { exact: true })
    .waitFor({ state: "detached" });
  assert.equal(
    project.nodes.find((node) => node.id === legacyId)?.name,
    "recovered.tex",
  );
  assert.equal(
    legacyDoc.getText("source").toString(),
    "legacy source preserved",
  );
  await page.getByRole("tab", { name: "recovered.tex", exact: true }).waitFor();
  // The rename is also reported, with ?changed=1, before a slow click.
  const repairedCompile = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/compile/${projectId}` &&
      !new URL(response.url()).searchParams.has("changed"),
  );
  await page.getByRole("button", { name: /^Compile status:/ }).click();
  assert.equal((await repairedCompile).status(), 200);
  await page.getByRole("button", { name: /^Compile status:/ }).waitFor();
  assert.equal(submissions.length, 3);
  assert(Object.hasOwn(submissions[2]?.files ?? {}, "figures/recovered.tex"));
  assert.equal(
    project.nodes.find((node) => node.id === legacyId)?.parentId,
    created.folder.id,
  );
  assert(!Object.hasOwn(submissions[2]?.files ?? {}, "chapter:1.tex"));
  console.info("Checking drag and drop in the file tree");
  const tree = page.getByRole("list", { name: "Project files" });
  const treeItem = (name: string) =>
    tree.getByRole("button", { name, exact: true });
  async function waitForNode(name: string, parentId: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        project.nodes.some(
          (node) => node.name === name && node.parentId === parentId,
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`${name} was not stored in ${parentId}`);
  }
  await treeItem("notes.txt").dragTo(treeItem("figures"));
  await waitForNode("notes.txt", created.folder.id);
  await treeItem("main.tex").dragTo(treeItem("out"));
  assert.equal(
    project.nodes.find((node) => node.id === mainId)?.parentId,
    rootId,
    "out/ must not accept moves",
  );
  await page.evaluate(
    (parentId) =>
      window.uploadTest.create({ parentId, name: "empty.tex", kind: "text" }),
    created.folder.id,
  );
  await page.evaluate(() => window.uploadTest.refresh());
  // Folders sort first, so the root copy is the last one in the tree.
  await treeItem("empty.tex").nth(1).waitFor();
  await treeItem("empty.tex").last().dragTo(treeItem("figures"));
  await page
    .getByRole("dialog", { name: "Move failed" })
    .getByRole("alert")
    .filter({ hasText: "already exists" })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  async function dropFiles(
    target: string,
    files: Array<{ name: string; size?: number }>,
  ) {
    const dataTransfer = await page.evaluateHandle((files) => {
      const data = new DataTransfer();
      for (const { name, size } of files)
        data.items.add(
          new File([size ? new Uint8Array(size) : `dropped ${name}`], name, {
            type: "text/plain",
          }),
        );
      return data;
    }, files);
    await treeItem(target).dispatchEvent("dragover", { dataTransfer });
    await treeItem(target).dispatchEvent("drop", { dataTransfer });
  }
  await dropFiles("figures", [{ name: "dropped.txt" }]);
  await waitForNode("dropped.txt", created.folder.id);
  await page.getByRole("tab", { name: "dropped.txt", exact: true }).waitFor();
  await dropFiles("figures", [
    { name: "small.txt" },
    { name: "huge.txt", size: 10 * 1024 * 1024 + 1 },
  ]);
  await page
    .getByRole("dialog", { name: "Upload failed" })
    .getByRole("alert")
    .filter({ hasText: "huge.txt exceeds 10 MiB" })
    .waitFor();
  assert(
    !project.nodes.some((node) => node.name === "small.txt"),
    "A rejected drop must not store any file",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.info(
    "Binary upload failure → retry → compile failure → retry → real Tectonic PDF rendered without navigation; binary transport is hash-only.",
  );
} finally {
  await browser.close();
  await vite.close();
  await backend.stop(true);
  for (const doc of documents.values()) doc.destroy();
}
