import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { z } from "zod";

/**
 * The document ID of a project's scratchpad: shared Markdown notes that are not
 * a file. Every other document is a text file, identified by its node.
 */
export const scratchpadId = "scratchpad";
export const documentIdSchema = z.union([z.uuid(), z.literal(scratchpadId)]);

export const maxCollaborationBytes = 20 * 1024 * 1024;
// A client's frame repeats its user, which the room ignores. What the room keeps is
// smaller: see `maxCursorLength`.
const maxAwarenessBytes = 2048;
/** Names are stored with each socket, whose storage is limited. */
export const maxNameLength = 100;
/**
 * The stored cursor's JSON. With the name and IDs, a socket's stored data stays
 * under 1 KiB of the 2 KiB that Durable Objects allow.
 */
const maxCursorLength = 512;
const maxControlLength = 1024;

/**
 * Clients that speak this protocol connect with `?protocol=2`. Older tabs that
 * still send base64 JSON are told to reload instead of being synchronized.
 */
export const collaborationProtocol = "2";
export const protocolSearchParam = "protocol";
/** Clients that understand `people` messages connect with `?people=1`. */
export const peopleSearchParam = "people";
export const outdatedClientMessage =
  "Texfolia was updated. Reload this page to keep collaborating; your offline edits are kept in this browser.";

// Yjs traffic travels as binary frames whose first byte is the message type,
// as y-websocket does. Control messages (`save`, `saved`, `error`, `people`)
// stay JSON.
const frameType = { sync: 0, update: 1, awareness: 2 } as const;

const syncMetaSchema = z.object({
  dirty: z.boolean(),
  objectKey: z.string().nullable(),
  canWrite: z.boolean(),
  user: z.object({ name: z.string(), color: z.string() }),
});
const clientControlSchema = z.strictObject({
  type: z.literal("save"),
  id: z.uuid(),
});
const serverControlSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("saved"),
    id: z.uuid(),
    value: z.string(),
    // Null for the scratchpad, which is saved in the room.
    objectKey: z.string().nullable(),
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    id: z.uuid().optional(),
  }),
  // Everyone with a file open in the project, whichever file it is.
  z.object({
    type: z.literal("people"),
    people: z.array(
      z.object({
        name: z.string(),
        color: z.string(),
        nodeId: documentIdSchema.optional(),
      }),
    ),
  }),
]);
export type Person = { name: string; color: string; nodeId?: string };

export type ClientMessage =
  | { type: "sync"; vector: Uint8Array }
  | { type: "update"; update: Uint8Array }
  | { type: "awareness"; update: Uint8Array }
  // While synchronized every update has already been sent on the ordered
  // socket, so a save carries no payload.
  | z.infer<typeof clientControlSchema>;
export type ServerMessage =
  | ({ type: "sync"; update: Uint8Array; vector: Uint8Array } & z.infer<
      typeof syncMetaSchema
    >)
  | { type: "update"; update: Uint8Array }
  | { type: "awareness"; update: Uint8Array }
  | z.infer<typeof serverControlSchema>;

function asBytes(data: ArrayBuffer | ArrayBufferView) {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function frame(type: number, payload: Uint8Array) {
  const bytes = new Uint8Array(payload.byteLength + 1);
  bytes[0] = type;
  bytes.set(payload, 1);
  return bytes;
}

export function encodeClientMessage(message: ClientMessage) {
  switch (message.type) {
    case "sync":
      return frame(frameType.sync, message.vector);
    case "update":
    case "awareness":
      return frame(frameType[message.type], message.update);
    case "save":
      return JSON.stringify(message);
  }
}

export function decodeClientMessage(
  data: string | ArrayBuffer | ArrayBufferView,
): ClientMessage {
  if (typeof data === "string") {
    if (data.length > maxControlLength)
      throw new Error("Invalid collaboration message");
    return clientControlSchema.parse(JSON.parse(data));
  }
  if (data.byteLength < 1 || data.byteLength > maxCollaborationBytes + 1)
    throw new Error("Invalid collaboration message");
  const bytes = asBytes(data);
  const payload = bytes.subarray(1);
  switch (bytes[0]) {
    case frameType.sync:
      return { type: "sync", vector: payload };
    case frameType.update:
      return { type: "update", update: payload };
    case frameType.awareness:
      if (payload.byteLength > maxAwarenessBytes)
        throw new Error("Invalid collaboration message");
      return { type: "awareness", update: payload };
    default:
      throw new Error("Invalid collaboration message");
  }
}

export function encodeServerMessage(message: ServerMessage) {
  switch (message.type) {
    case "sync": {
      const { update, vector, dirty, objectKey, canWrite, user } = message;
      const encoder = encoding.createEncoder();
      encoding.writeUint8(encoder, frameType.sync);
      encoding.writeVarUint8Array(encoder, update);
      encoding.writeVarUint8Array(encoder, vector);
      encoding.writeVarString(
        encoder,
        JSON.stringify({ dirty, objectKey, canWrite, user }),
      );
      return encoding.toUint8Array(encoder);
    }
    case "update":
    case "awareness":
      return frame(frameType[message.type], message.update);
    default:
      return JSON.stringify(message);
  }
}

export function decodeServerMessage(data: unknown): ServerMessage {
  if (typeof data === "string")
    return serverControlSchema.parse(JSON.parse(data));
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))
    throw new Error("Invalid collaboration response");
  const bytes = asBytes(data);
  if (bytes.byteLength < 1) throw new Error("Invalid collaboration response");
  switch (bytes[0]) {
    case frameType.sync: {
      const decoder = decoding.createDecoder(bytes.subarray(1));
      const update = decoding.readVarUint8Array(decoder);
      const vector = decoding.readVarUint8Array(decoder);
      const meta = syncMetaSchema.parse(
        JSON.parse(decoding.readVarString(decoder)),
      );
      return { type: "sync", update, vector, ...meta };
    }
    case frameType.update:
      return { type: "update", update: bytes.subarray(1) };
    case frameType.awareness:
      return { type: "awareness", update: bytes.subarray(1) };
    default:
      throw new Error("Invalid collaboration response");
  }
}
const positionId = z.object({
  client: z.number().int().nonnegative(),
  clock: z.number().int().nonnegative(),
});
const relativePosition = z.object({
  type: positionId.nullable().optional(),
  // Every document has one root type.
  tname: z.literal("source").nullable().optional(),
  item: positionId.nullable().optional(),
  assoc: z.number().int().optional(),
});
const awarenessState = z.object({
  cursor: z
    .object({ anchor: relativePosition, head: relativePosition })
    .nullable()
    .optional(),
});

export function awarenessFrame(
  clientId: number,
  clock: number,
  state: unknown,
) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, clientId);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}

// A client's awareness state as JSON, without the user, which the room adds.
export function readAwareness(bytes: Uint8Array, clientId: number) {
  const decoder = decoding.createDecoder(bytes);
  if (
    decoding.readVarUint(decoder) !== 1 ||
    decoding.readVarUint(decoder) !== clientId
  )
    throw new Error("Invalid awareness identity");
  const clock = decoding.readVarUint(decoder);
  const raw: unknown = JSON.parse(decoding.readVarString(decoder));
  const cursor =
    raw === null
      ? null
      : JSON.stringify(awarenessState.parse(raw).cursor ?? null);
  if (cursor !== null && cursor.length > maxCursorLength)
    throw new Error("Invalid collaboration message");
  return { clock, cursor };
}
