import { sharingLimit } from "@texfolia/db/schema";
import { eq, sql } from "drizzle-orm";

import type { ProjectTransaction } from "#/lib/projects/server";

// Shared by every way a user can make Texfolia email someone about a project.
export const sharingEmailLimits = { minute: 10, day: 50 } as const;

/**
 * Counts one sharing email against the user's budget, or throws. Counting in
 * the caller's transaction makes concurrent requests by one user take turns.
 */
export async function takeSharingEmail(tx: ProjectTransaction, userId: string) {
  for (const window of ["minute", "day"] as const) {
    const cutoff = sql.raw(`now() - interval '1 ${window}'`);
    const expired = sql`${sharingLimit.startedAt} <= ${cutoff}`;
    const [taken] = await tx
      .insert(sharingLimit)
      .values({ userId, window, count: 1, startedAt: sql`now()` })
      .onConflictDoUpdate({
        target: [sharingLimit.userId, sharingLimit.window],
        set: {
          count: sql`case when ${expired} then 1 else ${sharingLimit.count} + 1 end`,
          startedAt: sql`case when ${expired} then now() else ${sharingLimit.startedAt} end`,
        },
        setWhere: sql`${expired} or ${sharingLimit.count} < ${sharingEmailLimits[window]}`,
      })
      .returning({ count: sharingLimit.count });
    if (!taken)
      throw new Error(
        window === "minute"
          ? "You're sharing too quickly. Wait a minute and try again."
          : "You've reached today's sharing limit. Try again tomorrow.",
      );
  }
}

/**
 * Non-throwing variant for mention emails: consumes one slot from the shared
 * outbound email budget if available, or returns `false` without aborting the
 * caller's transaction.
 */
export async function tryTakeSharingEmail(
  tx: ProjectTransaction,
  userId: string,
): Promise<boolean> {
  const existing = await tx
    .select({
      window: sharingLimit.window,
      count: sharingLimit.count,
      expired: sql<boolean>`${sharingLimit.startedAt} <= now() - (case when ${sharingLimit.window} = 'minute' then interval '1 minute' else interval '1 day' end)`,
    })
    .from(sharingLimit)
    .where(eq(sharingLimit.userId, userId))
    .for("update");
  for (const row of existing) {
    if (!row.expired && row.count >= sharingEmailLimits[row.window])
      return false;
  }
  for (const window of ["minute", "day"] as const) {
    const cutoff = sql.raw(`now() - interval '1 ${window}'`);
    const expired = sql`${sharingLimit.startedAt} <= ${cutoff}`;
    const [taken] = await tx
      .insert(sharingLimit)
      .values({ userId, window, count: 1, startedAt: sql`now()` })
      .onConflictDoUpdate({
        target: [sharingLimit.userId, sharingLimit.window],
        set: {
          count: sql`case when ${expired} then 1 else ${sharingLimit.count} + 1 end`,
          startedAt: sql`case when ${expired} then now() else ${sharingLimit.startedAt} end`,
        },
        setWhere: sql`${expired} or ${sharingLimit.count} < ${sharingEmailLimits[window]}`,
      })
      .returning({ count: sharingLimit.count });
    if (!taken) return false;
  }
  return true;
}
