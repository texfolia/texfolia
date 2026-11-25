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
/** How many more chats the history list loads at a time. */
export const threadPageSize = 50;
export const threadListSchema = z.object({
  threads: z.array(threadSchema),
  more: z.boolean(),
});
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

/**
 * The server keeps each thread's history, so the browser sends only the
 * newest message instead of resending the whole thread every turn.
 */
function latestMessageFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (typeof init?.body !== "string") return fetch(input, init);
  const body = JSON.parse(init.body) as unknown;
  if (
    body &&
    typeof body === "object" &&
    "messages" in body &&
    Array.isArray(body.messages)
  )
    return fetch(input, {
      ...init,
      body: JSON.stringify({ ...body, messages: body.messages.slice(-1) }),
    });
  return fetch(input, init);
}
export const sendLatestMessage: typeof fetch = Object.assign(
  latestMessageFetch,
  { preconnect: fetch.preconnect },
);
