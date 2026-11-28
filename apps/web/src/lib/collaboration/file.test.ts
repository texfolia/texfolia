import { afterAll, beforeAll, expect, test } from "bun:test";

import * as Y from "yjs";

import { CollaborationConnection } from "./connection";
import { CollaborativeFile } from "./file";
import {
  decodeMultiplexClientMessage,
  encodeMultiplexServerMessage,
  encodeServerMessage,
} from "./protocol";

const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  binaryType = "";
  url: string;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string | URL) {
    this.url = String(url);
    sockets.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

const names = ["window", "WebSocket"] as const;
const originals = names.map((name) =>
  Object.getOwnPropertyDescriptor(globalThis, name),
);
beforeAll(() => {
  const window = Object.assign(new EventTarget(), {
    location: { href: "http://localhost/" },
  });
  for (const [name, value] of [
    ["window", window],
    ["WebSocket", FakeSocket],
  ] as const)
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
});
afterAll(() => {
  for (const [index, name] of names.entries()) {
    const original = originals[index];
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function open(changes: string[] = []) {
  const file = new CollaborativeFile({
    projectId: "project",
    nodeId: "node",
    userId: "user",
    canWrite: true,
    onChange: (value) => changes.push(value),
  });
  await Promise.resolve();
  const socket = sockets.at(-1)!;
  const server = new Y.Doc();
  server.getText("source").insert(0, "text");
  const message = encodeServerMessage({
    type: "sync",
    update: Y.encodeStateAsUpdate(server),
    vector: Y.encodeStateVector(server),
    dirty: false,
    objectKey: null,
    canWrite: true,
    user: { name: "User", color: "#123456" },
  });
  if (typeof message === "string") throw new Error("Sync is binary");
  return { file, socket, sync: { data: message.slice().buffer } };
}

test("destroying a file rejects what waits for it at once", async () => {
  const { file } = await open();
  const ready = file.whenReady();
  const connected = file.whenConnected();
  file.destroy();
  await expect(ready).rejects.toThrow("This file was closed.");
  await expect(connected).rejects.toThrow("This file was closed.");
  await expect(file.whenReady()).rejects.toThrow("This file was closed.");
});

test("deleting a file rejects what waits for it at once", async () => {
  const { file } = await open();
  const ready = file.whenReady();
  file.retire();
  await expect(ready).rejects.toThrow("This file was deleted.");
  file.destroy();
});

test("nothing a destroyed file's socket delivers reaches it", async () => {
  const changes: string[] = [];
  const { file, socket, sync } = await open(changes);
  const { onmessage, onclose, onerror } = socket;
  file.destroy();
  file.destroy();
  expect(socket.readyState).toBe(3);
  expect([
    socket.onopen,
    socket.onmessage,
    socket.onclose,
    socket.onerror,
  ]).toEqual([null, null, null, null]);
  // Events already being delivered when the handlers were removed.
  const status = file.getStatus();
  onmessage?.(sync);
  onclose?.();
  onerror?.();
  expect(changes).toEqual([]);
  expect(file.getStatus()).toBe(status);
});

test("a destroyed file is neither connected nor writable", async () => {
  const changes: string[] = [];
  const { file, socket, sync } = await open(changes);
  socket.onmessage?.(sync);
  expect(changes).toEqual(["text"]);
  await file.whenConnected();
  file.destroy();
  expect(file.getStatus()).toMatchObject({ connected: false, canWrite: false });
  await expect(file.whenConnected()).rejects.toThrow("This file was closed.");
  await expect(file.save()).rejects.toThrow();
});

test("multiple files multiplex over a single project WebSocket", async () => {
  const before = sockets.length;
  const projectId = crypto.randomUUID();
  const nodeA = crypto.randomUUID();
  const nodeB = crypto.randomUUID();
  const connection = new CollaborationConnection(projectId);
  const changesA: string[] = [];
  const changesB: string[] = [];
  const fileA = new CollaborativeFile({
    projectId,
    nodeId: nodeA,
    userId: "user",
    canWrite: true,
    connection,
    onChange: (value) => changesA.push(value),
  });
  const fileB = new CollaborativeFile({
    projectId,
    nodeId: nodeB,
    userId: "user",
    canWrite: true,
    connection,
    onChange: (value) => changesB.push(value),
  });
  await Promise.resolve();
  expect(sockets.length - before).toBe(1);
  const socket = sockets.at(-1)!;
  expect(socket.url).toContain(`/api/collaboration/${projectId}`);
  expect(socket.url).toContain("protocol=3");

  const docA = new Y.Doc();
  docA.getText("source").insert(0, "alpha");
  const docB = new Y.Doc();
  docB.getText("source").insert(0, "beta");

  const syncA = encodeMultiplexServerMessage({
    type: "sync",
    nodeId: nodeA,
    update: Y.encodeStateAsUpdate(docA),
    vector: Y.encodeStateVector(docA),
    dirty: false,
    objectKey: null,
    canWrite: true,
    user: { name: "User", color: "#123456" },
  });
  const syncB = encodeMultiplexServerMessage({
    type: "sync",
    nodeId: nodeB,
    update: Y.encodeStateAsUpdate(docB),
    vector: Y.encodeStateVector(docB),
    dirty: false,
    objectKey: null,
    canWrite: true,
    user: { name: "User", color: "#123456" },
  });
  if (typeof syncA === "string" || typeof syncB === "string")
    throw new Error("Sync is binary");

  socket.onmessage?.({ data: syncA.slice().buffer });
  socket.onmessage?.({ data: syncB.slice().buffer });
  expect(changesA).toEqual(["alpha"]);
  expect(changesB).toEqual(["beta"]);

  // Destroying one file sends close for that nodeId and keeps the shared socket open.
  fileA.destroy();
  expect(socket.readyState).toBe(FakeSocket.OPEN);
  const lastMessage = socket.sent.at(-1);
  expect(
    decodeMultiplexClientMessage(lastMessage as string | ArrayBuffer),
  ).toEqual({ type: "close", nodeId: nodeA });
  expect(fileB.getStatus().connected).toBe(true);

  // Destroying the last file closes the idle shared socket.
  fileB.destroy();
  expect(socket.readyState).toBe(FakeSocket.CLOSED);
  connection.destroy();
});
