import assert from "node:assert/strict";

import type { BuildSnapshot } from "@texfolia/contracts";
import * as Y from "yjs";

import {
  decodeClientMessage,
  decodeMultiplexClientMessage,
  encodeMultiplexServerMessage,
  encodeServerMessage,
  multiplexCollaborationProtocol,
  protocolSearchParam,
} from "#/lib/collaboration";
import { createNodeSchema } from "#/lib/projects";

import type { ProjectDetails } from "../../src/lib/projects/project.functions";
import { createWorkspaceServer } from "./workspace-server";

type Node = ProjectDetails["nodes"][number];

/** A project whose root folder holds these files, with their text if any. */
export function fixtureProject(
  name: string,
  files: { name: string; text?: string }[],
) {
  const id = crypto.randomUUID();
  const rootId = crypto.randomUUID();
  const nodes = files.map(({ name, text }): Node => ({
    id: crypto.randomUUID(),
    projectId: id,
    parentId: rootId,
    name,
    kind: text === undefined ? "binary" : "text",
  }));
  const project: ProjectDetails = {
    id,
    ownerId: "runtime-test",
    organizationId: null,
    name,
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
      {
        id: rootId,
        projectId: id,
        parentId: null,
        name: "root",
        kind: "folder",
      },
      ...nodes,
    ],
    sourceContents: Object.fromEntries(
      files.flatMap(({ text }, index) =>
        text === undefined ? [] : [[nodes[index]!.id, text]],
      ),
    ),
    commentsVersion: "0:0",
    gitVersion: "",
    sourceVersions: Object.fromEntries(
      nodes.map((node, index) => [
        node.id,
        {
          objectKey:
            node.kind === "binary"
              ? `projects/${id}/sources/${String(index).padStart(64, "0")}`
              : null,
          updatedAt: 0,
        },
      ]),
    ),
  };
  const node = (name: string) => {
    const found = nodes.find((node) => node.name === name);
    assert(found);
    return found;
  };
  return { project, rootId, node };
}

/** A build's snapshot, with the PDF at `output.pdf`. */
export function fixtureBuild(revision: number): BuildSnapshot {
  const build = {
    id: crypto.randomUUID(),
    revision,
    status: "succeeded" as const,
  };
  return {
    revision,
    current: build,
    latestBuild: build,
    stale: false,
    artifacts: {
      id: build.id,
      revision,
      digest: "fixture",
      builtAt: new Date().toISOString(),
      builtBy: "runtime-test",
      engine: "tectonic",
      pdf: "output.pdf",
      files: [{ path: "output.pdf", key: `pdf-${revision}`, sizeBytes: 500 }],
    },
  };
}

/**
 * Serves the real workspace against a fixture of its network. `handle` answers
 * requests before the fixture does.
 */
export async function startWorkspace({
  project,
  pdf,
  handle,
}: {
  project: ProjectDetails;
  pdf: () => Uint8Array<ArrayBuffer>;
  handle?: (
    request: Request,
    url: URL,
  ) => Response | undefined | Promise<Response | undefined>;
}) {
  const projectId = project.id;
  const documents = new Map<string, Y.Doc>();
  for (const [id, text] of Object.entries(project.sourceContents)) {
    const doc = new Y.Doc();
    doc.getText("source").insert(0, text);
    documents.set(id, doc);
  }
  let snapshot = fixtureBuild(1);
  const eventSockets = new Set<{ send(message: string): unknown }>();
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      data: { nodeId: "", events: false, multiplex: false },
      open(socket) {
        if (!socket.data.events) return;
        eventSockets.add(socket);
        socket.send(JSON.stringify(snapshot));
      },
      close(socket) {
        eventSockets.delete(socket);
      },
      message(socket, raw) {
        if (raw === "ping") return void socket.send("pong");
        if (socket.data.multiplex) {
          const message = decodeMultiplexClientMessage(raw);
          if (message.type === "close") return;
          const doc = documents.get(message.nodeId);
          assert(doc);
          if (message.type === "sync")
            socket.send(
              encodeMultiplexServerMessage({
                type: "sync",
                nodeId: message.nodeId,
                update: Y.encodeStateAsUpdate(doc, message.vector),
                vector: Y.encodeStateVector(doc),
                dirty: true,
                objectKey: null,
                canWrite: project.canWrite,
                user: { name: "Runtime test", color: "#123456" },
              }),
            );
          if (message.type === "update") Y.applyUpdate(doc, message.update);
          if (message.type === "save")
            socket.send(
              encodeMultiplexServerMessage({
                type: "saved",
                nodeId: message.nodeId,
                id: message.id,
                value: doc.getText("source").toString(),
                objectKey: null,
                updatedAt: Date.now(),
              }),
            );
          return;
        }
        const message = decodeClientMessage(raw);
        const doc = documents.get(socket.data.nodeId);
        assert(doc);
        if (message.type === "sync")
          socket.send(
            encodeServerMessage({
              type: "sync",
              update: Y.encodeStateAsUpdate(doc, message.vector),
              vector: Y.encodeStateVector(doc),
              dirty: true,
              objectKey: null,
              canWrite: project.canWrite,
              user: { name: "Runtime test", color: "#123456" },
            }),
          );
        if (message.type === "update") Y.applyUpdate(doc, message.update);
        if (message.type === "save")
          socket.send(
            encodeServerMessage({
              type: "saved",
              id: message.id,
              value: doc.getText("source").toString(),
              objectKey: null,
              updatedAt: Date.now(),
            }),
          );
      },
    },
    async fetch(request, server) {
      const url = new URL(request.url);
      const handled = await handle?.(request, url);
      if (handled) return handled;
      if (url.pathname.startsWith("/api/collaboration/")) {
        const multiplex =
          url.searchParams.get(protocolSearchParam) ===
          multiplexCollaborationProtocol;
        return server.upgrade(request, {
          data: {
            nodeId: multiplex ? "" : (url.pathname.split("/").at(-1) ?? ""),
            events: false,
            multiplex,
          },
        })
          ? undefined
          : new Response(null, { status: 400 });
      }
      if (
        url.pathname === "/fixture/project" ||
        url.pathname === `/api/projects/${projectId}/metadata`
      )
        return Response.json(project);
      if (url.pathname === "/fixture/nodes") {
        const input = createNodeSchema.parse(await request.json());
        documents.set(input.id, new Y.Doc());
        const sourceVersion = { objectKey: null, updatedAt: Date.now() };
        project.nodes.push(input);
        project.sourceVersions[input.id] = sourceVersion;
        return Response.json({ ...input, sourceVersion });
      }
      if (url.searchParams.has("events"))
        return server.upgrade(request, {
          data: { nodeId: "", events: true, multiplex: false },
        })
          ? undefined
          : new Response(null, { status: 426 });
      if (url.searchParams.has("file"))
        return new Response(pdf(), {
          headers: { "Content-Type": "application/pdf" },
        });
      return new Response(null, {
        status: request.method === "POST" ? 204 : 404,
      });
    },
  });

  const vite = await createWorkspaceServer({
    entry: "editor-runtime",
    backend: backend.url,
  });
  await vite.listen();
  return {
    url: vite.resolvedUrls?.local[0] ?? "",
    documents,
    /** Tells open tabs about the next finished build. */
    publishBuild() {
      snapshot = fixtureBuild(snapshot.revision + 1);
      for (const socket of eventSockets) socket.send(JSON.stringify(snapshot));
    },
    async stop() {
      await vite.close();
      await backend.stop(true);
      for (const doc of documents.values()) doc.destroy();
    },
  };
}

export async function eventually<T>(
  check: () => Promise<T> | T,
  expected: T,
  label: string,
) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const actual = await check();
    try {
      return assert.deepEqual(actual, expected, label);
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
