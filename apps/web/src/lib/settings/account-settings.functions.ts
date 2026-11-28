import { createServerFn } from "@tanstack/react-start";
import { account } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { ensureSession } from "#/lib/auth/auth.functions";

export const getConnections = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const session = await ensureSession();
    return context.db
      .select({
        id: account.id,
        provider: account.providerId,
        scope: account.scope,
        createdAt: account.createdAt,
      })
      .from(account)
      .where(eq(account.userId, session.user.id))
      .orderBy(account.createdAt);
  },
);
export const getAccountAiSettings = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const session = await ensureSession();
    const server = await import("./account-settings.server");
    return server.getAccountAiSettings(context.db, session.user.id);
  },
);
export const saveAccountAiSettings = createServerFn({ method: "POST" })
  .validator(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("model"),
        model: z.string().min(1).max(200).nullable(),
      }),
      z.object({
        kind: z.literal("cap"),
        dollars: z.number().finite().min(0).max(10000).multipleOf(0.01),
      }),
    ]),
  )
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./account-settings.server");
    return server.saveAccountAiSettings(context.db, session.user.id, data);
  });
export const getAccountUsage = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const session = await ensureSession();
    const server = await import("./account-settings.server");
    return server.getAccountUsage(context.db, session.user.id);
  },
);
