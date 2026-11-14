import { z } from "zod";

export const historyCadenceMs = 5 * 60_000;
export const historyRetentionDays = 30;
export const historyRetentionMs = historyRetentionDays * 24 * 60 * 60_000;
export const historyPolicy = `${historyRetentionDays}-day document history; named versions kept`;
export const historyDocumentSchema = z.object({
  projectId: z.uuid(),
  nodeId: z.uuid(),
});
export const historyVersionSchema = historyDocumentSchema.extend({
  versionId: z.uuid(),
});
export const historyLabelSchema = z.string().trim().min(1).max(100);
export const historyAuthorSchema = z.object({
  userId: z.string(),
  name: z.string(),
});
export type HistoryAuthor = z.infer<typeof historyAuthorSchema>;
export const documentVersionSchema = z.object({
  id: z.uuid(),
  createdAt: z.number(),
  label: historyLabelSchema.nullable(),
  kind: z.enum(["automatic", "named", "restore", "before-restore"]),
  authors: z.array(historyAuthorSchema),
  restoredFrom: z.uuid().nullable(),
});
export type DocumentVersion = z.infer<typeof documentVersionSchema>;
