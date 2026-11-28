import { z } from "zod";

export const mentionCandidatesSchema = z.object({
  projectId: z.uuid(),
});

export const syncScratchpadMentionsSchema = z.object({
  projectId: z.uuid(),
  body: z.string().max(500_000),
});

export const resolveMentionsSchema = z.object({
  projectId: z.uuid(),
  userIds: z.array(z.string().min(1).max(128)).max(200),
});
