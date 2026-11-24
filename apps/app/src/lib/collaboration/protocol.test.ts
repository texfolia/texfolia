import { describe, expect, test } from "bun:test";

import {
  awarenessFrame,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  maxCollaborationBytes,
  type ServerMessage,
} from "./protocol";

const bytes = (...values: number[]) => new Uint8Array(values);
const buffer = (frame: string | Uint8Array) => {
  if (typeof frame === "string") return frame;
  return frame.slice().buffer;
};

describe("collaboration protocol", () => {
  test("Yjs traffic is binary with a one-byte type and raw payload", () => {
    const update = bytes(1, 2, 3);
    for (const [message, type] of [
      [{ type: "sync", vector: update }, 0],
      [{ type: "update", update }, 1],
      [{ type: "awareness", update }, 2],
    ] as const) {
      const frame = encodeClientMessage(message);
      expect(frame).toEqual(bytes(type, 1, 2, 3));
      expect(decodeClientMessage(buffer(frame))).toEqual(message);
    }
  });

  test("Bun buffers and offset views decode", () => {
    const backing = bytes(9, 1, 7, 8);
    expect(decodeClientMessage(backing.subarray(1))).toEqual({
      type: "update",
      update: bytes(7, 8),
    });
    expect(decodeClientMessage(Buffer.from([0, 5]))).toEqual({
      type: "sync",
      vector: bytes(5),
    });
  });

  test("saves stay JSON control messages", () => {
    const save = { type: "save", id: crypto.randomUUID() } as const;
    const frame = encodeClientMessage(save);
    expect(typeof frame).toBe("string");
    expect(decodeClientMessage(frame)).toEqual(save);
  });

  test("old base64 JSON Yjs messages are rejected", () => {
    for (const message of [
      { type: "sync", vector: "AA==" },
      { type: "update", update: "AA==" },
      { type: "awareness", update: "AA==" },
      { type: "save", id: crypto.randomUUID(), update: "AA==" },
    ])
      expect(() => decodeClientMessage(JSON.stringify(message))).toThrow();
  });

  test("malformed and oversized frames are rejected", () => {
    expect(() => decodeClientMessage(new ArrayBuffer(0))).toThrow();
    expect(() => decodeClientMessage(bytes(7, 1).buffer)).toThrow();
    expect(() =>
      decodeClientMessage(new ArrayBuffer(maxCollaborationBytes + 2)),
    ).toThrow();
    expect(() =>
      decodeClientMessage(new Uint8Array(8000).fill(2).buffer),
    ).toThrow();
    expect(() => decodeClientMessage("x".repeat(2000))).toThrow();
  });

  test("server sync carries update, vector and metadata in one frame", () => {
    const sync = {
      type: "sync",
      update: bytes(4, 5, 6),
      vector: bytes(0),
      dirty: true,
      objectKey: null,
      canWrite: false,
      user: { name: "Ada", color: "#123456" },
    } as const;
    const frame = encodeServerMessage(sync);
    expect(frame).toBeInstanceOf(Uint8Array);
    expect(decodeServerMessage(buffer(frame))).toEqual(sync);
  });

  test("server updates, awareness and control messages round-trip", () => {
    const awareness = awarenessFrame(3, 1, null);
    for (const message of [
      { type: "update", update: bytes(1) },
      { type: "awareness", update: awareness },
      {
        type: "saved",
        id: crypto.randomUUID(),
        value: "text",
        objectKey: "key",
        updatedAt: 1,
      },
      {
        type: "saved",
        id: crypto.randomUUID(),
        value: "notes",
        objectKey: null,
        updatedAt: 1,
      },
      { type: "error", message: "nope" },
      { type: "people", people: [{ name: "Ada", color: "#123456" }] },
    ] satisfies ServerMessage[])
      expect(decodeServerMessage(buffer(encodeServerMessage(message)))).toEqual(
        message,
      );
    expect(() => decodeServerMessage(new Blob())).toThrow();
    expect(() => decodeServerMessage(bytes(9).buffer)).toThrow();
  });
});
