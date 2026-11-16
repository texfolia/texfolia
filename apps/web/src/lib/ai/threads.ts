import { z } from "zod";

export const storedMessageSchema = z.object({
  id: z.string().min(1).max(200),
  role: z.enum(["user", "assistant"]),
  parts: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), content: z.string() }),
      z.object({
        type: z.literal("thinking"),
        content: z.string(),
        stepId: z.string().optional(),
        signature: z.string().optional(),
        redacted: z.boolean().optional(),
      }),
      z.object({
        type: z.literal("tool-call"),
        id: z.string(),
        name: z.string(),
        arguments: z.string(),
        input: z.unknown().optional(),
        output: z.unknown().optional(),
        state: z.enum([
          "awaiting-input",
          "input-streaming",
          "input-complete",
          "approval-requested",
          "approval-responded",
          "complete",
          "error",
        ]),
      }),
      z.object({
        type: z.literal("tool-result"),
        toolCallId: z.string(),
        content: z.string(),
        state: z.enum(["streaming", "complete", "error"]),
        error: z.string().optional(),
      }),
    ]),
  ),
});
export type StoredMessage = z.infer<typeof storedMessageSchema>;
export const threadSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  model: z.string().nullable(),
  updatedAt: z.string(),
});
export type AssistantThread = z.infer<typeof threadSchema>;
export const threadHistorySchema = z.object({
  thread: threadSchema,
  messages: z.array(storedMessageSchema),
});
export const threadActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    title: z.string().trim().min(1).max(200).default("New chat"),
  }),
  z.object({
    kind: z.literal("rename"),
    id: z.uuid(),
    title: z.string().trim().min(1).max(200),
  }),
  z.object({ kind: z.literal("delete"), id: z.uuid() }),
  z.object({
    kind: z.literal("model"),
    id: z.uuid(),
    model: z.string().min(1).max(200).nullable(),
  }),
]);
