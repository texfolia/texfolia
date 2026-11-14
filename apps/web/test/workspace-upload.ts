import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";
import { createServer } from "vite";
import * as Y from "yjs";

import { clientMessageSchema } from "../src/lib/collaboration/protocol";
import { compileDeltaSchema, hashSource } from "../src/lib/latex/source-sync";
import { createNodeSchema } from "../src/lib/project-node.schema";
import {
  decodeSource,
  encodeSource,
  type SourceFiles,
} from "../src/lib/project-source";
import type { ProjectDetails } from "../src/lib/project.functions";
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
  canWrite: true,
  nodes: [
    { id: rootId, projectId, parentId: null, name: "root", kind: "folder" },
    { id: mainId, projectId, parentId: rootId, name: "main.tex", kind: "text" },
  ],
  sourceContents: { [mainId]: main },
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
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
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
  return new TextEncoder().encode(`data: ${JSON.stringify(snapshot())}\n\n`);
}

// The network boundary is a fixture; React, upload, collection, collaboration
// client, workspace, compile transport, Tectonic, and PDF.js all run for real.
const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 120,
  websocket: {
    data: { nodeId: "" },
    async message(socket, raw) {
      if (raw === "ping") {
        socket.send("pong");
        return;
      }
      const message = clientMessageSchema.parse(JSON.parse(String(raw)));
      const doc = documents.get(socket.data.nodeId);
      assert(doc);
      if (message.type === "sync")
        socket.send(
          JSON.stringify({
            type: "sync",
            update: encodeSource(Y.encodeStateAsUpdate(doc)),
            vector: encodeSource(Y.encodeStateVector(doc)),
            canWrite: true,
            user: { name: "Upload test", color: "#123456" },
          }),
        );
      if (message.type === "update" || message.type === "save")
        Y.applyUpdate(doc, decodeSource(message.update));
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
      if (
        server.upgrade(request, {
          data: { nodeId: url.pathname.split("/").at(-1) ?? "" },
        })
      )
        return;
      return new Response(null, { status: 400 });
    }
    if (url.pathname === "/fixture/project") return Response.json(project);
    if (url.pathname === `/api/projects/${projectId}/metadata`)
      return Response.json(project);
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

    if (url.searchParams.has("events")) {
      let subscriber: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            subscriber = controller;
            subscribers.add(controller);
            controller.enqueue(event());
          },
          cancel() {
            subscribers.delete(subscriber);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
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
      const files: SourceFiles = {};
      for (const [path, source] of Object.entries(delta.files)) {
        if (path.endsWith(".png")) {
          assert.deepEqual(
            Object.keys(source),
            ["hash"],
            "Binary compile transport must contain only its hash",
          );
          const bytes = sourceObjects.get(source.hash);
          assert(bytes, "Compile referenced an unacknowledged object");
          files[path] = { base64: encodeSource(bytes) };
        } else {
          const bytes = sourceObjects.get(source.hash);
          assert(source.content !== undefined || bytes);
          files[path] = source.content ?? new TextDecoder().decode(bytes);
        }
      }
      jobId = request.headers.get("X-Compilation-Id") ?? "";
      const response = await fetch(new URL("/compile", engineUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Compilation-Id": jobId,
        },
        body: JSON.stringify({ mainFile: delta.mainFile, files }),
      });
      assert(response.ok, await response.clone().text());
      const form = await response.formData();
      const artifact = form.get("pdf");
      assert(artifact instanceof Blob);
      pdf = artifact;
      for (const subscriber of subscribers) subscriber.enqueue(event());
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
      name: "workspace-upload-fixture",
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
      "#/lib/project-node.functions": rpc,
      "#/lib/project-source.functions": rpc,
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
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error);
  });
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.goto(vite.resolvedUrls?.local[0] ?? "");
  console.info("Checking workspace initialization");
  await page
    .locator('.cm-content[contenteditable="true"]')
    .waitFor()
    .catch(async (error) => {
      console.error(await page.locator("body").innerText());
      throw error;
    });
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
  await page
    .getByText("Preview is not available for this file type.")
    .waitFor();
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
  await page
    .getByRole("button", { name: "Save & compile", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Save & compile", exact: true })
    .click();
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
