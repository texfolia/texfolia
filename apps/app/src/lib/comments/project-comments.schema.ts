import { z } from "zod";

export const maxCommentLength = 10_000;
export const maxCommentQuoteLength = 1_000;
export const maxCommentThreads = 2_000;
export const maxThreadComments = 200;

// An encoded Yjs relative position is a few varints; 256 base64 characters is
// far more than any valid one needs.
const anchorSchema = z.base64().min(4).max(256);
const bodySchema = z
  .string()
  .trim()
  .min(1, "Write a comment first.")
  .max(
    maxCommentLength,
    `Comments can be at most ${maxCommentLength} characters.`,
  );

export const commentsSchema = z.object({ projectId: z.uuid() });
export const commentThreadSchema = commentsSchema.extend({
  threadId: z.uuid(),
});
export const createCommentThreadSchema = commentsSchema.extend({
  nodeId: z.uuid(),
  anchorStart: anchorSchema,
  anchorEnd: anchorSchema,
  quote: z.string().max(maxCommentQuoteLength),
  body: bodySchema,
});
export const replyToCommentThreadSchema = commentsSchema.extend({
  threadId: z.uuid(),
  body: bodySchema,
});
export const resolveCommentThreadSchema = commentsSchema.extend({
  threadId: z.uuid(),
  resolved: z.boolean(),
});
export const deleteCommentThreadSchema = commentsSchema.extend({
  threadId: z.uuid(),
});
export const updateCommentSchema = commentsSchema.extend({
  commentId: z.uuid(),
  body: bodySchema,
});
export const deleteCommentSchema = commentsSchema.extend({
  commentId: z.uuid(),
});

// Truncates the selected text stored with a new thread.
export function commentQuote(text: string) {
  return text.length > maxCommentQuoteLength
    ? `${text.slice(0, maxCommentQuoteLength - 1)}…`
    : text;
}
