import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { z } from "zod";

export const maxCollaborationBytes = 20 * 1024 * 1024;
const updateSchema = z.base64().max(4 * Math.ceil(maxCollaborationBytes / 3));

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sync"), vector: updateSchema }),
  z.object({ type: z.literal("update"), update: updateSchema }),
  z.object({ type: z.literal("awareness"), update: z.string().max(8192) }),
  z.object({
    type: z.literal("save"),
    id: z.uuid(),
    // Omitted when the server already has every update; otherwise a state-vector diff.
    update: updateSchema.optional(),
  }),
]);
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sync"),
    update: updateSchema,
    vector: updateSchema,
    dirty: z.boolean(),
    objectKey: z.string().nullable(),
    canWrite: z.boolean(),
    user: z.object({ name: z.string(), color: z.string() }),
  }),
  z.object({ type: z.literal("update"), update: updateSchema }),
  z.object({ type: z.literal("awareness"), update: z.string() }),
  z.object({
    type: z.literal("saved"),
    id: z.uuid(),
    value: z.string(),
    objectKey: z.string(),
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    id: z.uuid().optional(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

const positionId = z.object({
  client: z.number().int().nonnegative(),
  clock: z.number().int().nonnegative(),
});
const relativePosition = z.object({
  type: positionId.nullable().optional(),
  tname: z.string().nullable().optional(),
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

export function readAwareness(
  bytes: Uint8Array,
  clientId: number,
  user: { name: string; color: string },
) {
  const decoder = decoding.createDecoder(bytes);
  if (
    decoding.readVarUint(decoder) !== 1 ||
    decoding.readVarUint(decoder) !== clientId
  )
    throw new Error("Invalid awareness identity");
  const clock = decoding.readVarUint(decoder);
  const raw: unknown = JSON.parse(decoding.readVarString(decoder));
  const state = raw === null ? null : { ...awarenessState.parse(raw), user };
  return { clock, frame: awarenessFrame(clientId, clock, state) };
}
