import type { JobTiming } from "@texfolia/contracts";
import type { Db } from "@texfolia/db";
import { projectJob } from "@texfolia/db/schema";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

// Mirrors `compileHistoryLimit`, `sessionHistoryLimit`, `timelineRetentionMs`.
const recentTimelineLimit = 10;
const sessionTimelineLimit = 200;
const timelineRetentionMs = 24 * 60 * 60_000;

export function updateProjectJob(
  db: Db,
  id: string,
  values: PgUpdateSetSource<typeof projectJob>,
) {
  return db
    .update(projectJob)
    .set(values)
    .where(
      and(
        eq(projectJob.id, id),
        inArray(projectJob.status, ["queued", "running"]),
      ),
    );
}

// Adds top-level keys to the job timeline without replacing other parts.
export function mergeJobTiming(value: Record<string, unknown>) {
  return sql`coalesce(${projectJob.timing}, '{}'::jsonb) || ${JSON.stringify(value)}::jsonb`;
}

export function compilerTimeline(result: {
  createdAt?: string;
  timing?: JobTiming;
}) {
  return { compiler: { ...result.timing, acceptedAt: result.createdAt } };
}

// Recent compiles keep a timeline so the Logs tab can show a whole editing
// session; older rows remain for accounting.
async function pruneTimelines(db: Db, projectId: string) {
  const latest = (limit: number) =>
    db
      .select({ id: projectJob.id })
      .from(projectJob)
      .where(eq(projectJob.projectId, projectId))
      .orderBy(desc(projectJob.createdAt))
      .limit(limit);
  await db
    .update(projectJob)
    .set({ timing: null })
    .where(
      and(
        eq(projectJob.projectId, projectId),
        isNotNull(projectJob.timing),
        notInArray(projectJob.id, latest(recentTimelineLimit)),
        or(
          lt(projectJob.createdAt, new Date(Date.now() - timelineRetentionMs)),
          notInArray(projectJob.id, latest(sessionTimelineLimit)),
        ),
      ),
    );
}

export async function finishProjectJob(
  db: Db,
  projectId: string,
  id: string,
  values: PgUpdateSetSource<typeof projectJob>,
) {
  const updated = await updateProjectJob(db, id, values).returning({
    id: projectJob.id,
  });
  if (updated.length)
    await pruneTimelines(db, projectId).catch((error: unknown) => {
      console.error("Compile timeline pruning failed", { projectId, error });
    });
}

export type ReconcilableJob =
  | {
      id: string;
      status: "succeeded";
      createdAt: string;
      log: string;
      sizeBytes: number;
      objectKey?: string;
      timing?: JobTiming;
    }
  | {
      id: string;
      status: "failed";
      createdAt: string;
      error: string;
      log: string;
      timing?: JobTiming;
    };

export async function reconcileProjectJob(
  db: Db,
  projectId: string,
  job: ReconcilableJob,
) {
  const finishedAt = new Date();
  const startedAt = job.timing?.startedAt
    ? new Date(job.timing.startedAt)
    : undefined;
  const compileMs = job.timing?.compileMs;
  const durationMs =
    typeof compileMs === "number" &&
    Number.isFinite(compileMs) &&
    compileMs >= 0
      ? Math.round(compileMs)
      : startedAt
        ? Math.max(0, Math.round(finishedAt.getTime() - startedAt.getTime()))
        : undefined;
  const timing = job.timing ? mergeJobTiming(compilerTimeline(job)) : undefined;
  if (job.status === "succeeded") {
    const sizeBytes = job.objectKey ? BigInt(job.sizeBytes) : 0n;
    await finishProjectJob(db, projectId, job.id, {
      status: "succeeded",
      log: job.log,
      objectKey: job.objectKey ?? null,
      sizeBytes,
      ...(startedAt ? { startedAt } : {}),
      finishedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(timing ? { timing } : {}),
    });
  } else {
    await finishProjectJob(db, projectId, job.id, {
      status: "failed",
      error: job.error,
      log: job.log,
      ...(startedAt ? { startedAt } : {}),
      finishedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(timing ? { timing } : {}),
    });
  }
}
