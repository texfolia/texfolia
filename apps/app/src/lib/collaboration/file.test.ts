import { afterAll, beforeAll, expect, test } from "bun:test";

import * as Y from "yjs";

import { CollaborativeFile } from "./file";
import { encodeServerMessage } from "./protocol";

const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  send() {}
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
