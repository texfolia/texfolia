import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { ensureSession } from "#/lib/auth/auth.functions";
import { createEmailDelivery } from "#/lib/email";

import {
  mentionCandidatesSchema,
  resolveMentionsSchema,
  syncScratchpadMentionsSchema,
} from "./mentions.schema";

export const listMentionCandidates = createServerFn({ method: "GET" })
  .validator(mentionCandidatesSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./people.server");
    return server.listProjectMentionCandidates({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
    });
  });

export const syncScratchpadMentions = createServerFn({ method: "POST" })
  .validator(syncScratchpadMentionsSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./scratchpad-mentions.server");
    return server.syncScratchpadMentions({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
      body: data.body,
      email: createEmailDelivery(env.BACKGROUND, process.env.BETTER_AUTH_URL),
    });
  });

export const resolveScratchpadMentions = createServerFn({ method: "POST" })
  .validator(resolveMentionsSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./scratchpad-mentions.server");
    return server.resolveScratchpadMentions({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
      userIds: data.userIds,
    });
  });
