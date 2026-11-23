import { nanoDollars } from "@texfolia/billing";
import { aiSpend, getAiSettings } from "@texfolia/billing/server";
import type { Db } from "@texfolia/db";
import { aiSettings, projectNode, projectJob } from "@texfolia/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { aiConfig, gatewayModels } from "./ai/gateway.server";
import type { AiModel } from "./ai/schema";
import { accessibleProjects } from "./project.server";

export async function getAccountAiSettings(db: Db, userId: string) {
  const settings = await getAiSettings(db, userId);
  let models: AiModel[] = [];
  let modelsError: string | null = null;
  try {
    models = await gatewayModels(aiConfig());
  } catch {
    modelsError =
      "The model catalog is unavailable. Try reloading this page later.";
  }
  return {
    defaultModel: settings.defaultModel,
    monthlyCapDollars: settings.monthlyCapNanos / nanoDollars,
    models,
    modelsError,
  };
}
export async function saveAccountAiSettings(
  db: Db,
  userId: string,
  data:
    | { kind: "model"; model: string | null }
    | { kind: "cap"; dollars: number },
) {
  if (
    data.kind === "model" &&
    data.model &&
    !(await gatewayModels(aiConfig())).some((model) => model.id === data.model)
  )
    throw new Error(
      "This model is no longer available. Reload the model catalog.",
    );
  await getAiSettings(db, userId);
  await db
    .update(aiSettings)
    .set(
      data.kind === "model"
        ? { defaultModel: data.model }
        : { monthlyCapNanos: Math.round(data.dollars * nanoDollars) },
    )
    .where(eq(aiSettings.userId, userId));
  return { saved: true };
}
export async function getAccountUsage(db: Db, userId: string) {
  const [projects, settings, spend] = await Promise.all([
    // Usage covers every accessible project, not one dashboard page.
    db.query.project.findMany({
      columns: { id: true },
      where: accessibleProjects(userId),
    }),
    getAiSettings(db, userId),
    aiSpend(db, userId),
  ]);
  const ids = projects.map((project) => project.id);
  const [storage] = ids.length
    ? await db
        .select({
          bytes: sql<string>`coalesce(sum(${projectNode.sizeBytes}), 0)`,
        })
        .from(projectNode)
        .where(
          and(
            inArray(projectNode.projectId, ids),
            isNull(projectNode.deletedAt),
          ),
        )
    : [];
  const [compiles] = ids.length
    ? await db
        .select({
          total: sql<number>`count(*)::int`,
          succeeded: sql<number>`count(*) filter (where ${projectJob.status} = 'succeeded')::int`,
          failed: sql<number>`count(*) filter (where ${projectJob.status} = 'failed')::int`,
        })
        .from(projectJob)
        .where(
          and(
            inArray(projectJob.projectId, ids),
            sql`${projectJob.createdAt} >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`,
          ),
        )
    : [];
  return {
    monthlyCapDollars: settings.monthlyCapNanos / nanoDollars,
    spentDollars: spend.spent / nanoDollars,
    reservedDollars: spend.reserved / nanoDollars,
    needsReview: spend.needsReview,
    pendingRequests: spend.pendingRequests,
    sourceBytes: storage?.bytes ?? "0",
    projectCount: ids.length,
    compiles: compiles ?? { total: 0, succeeded: 0, failed: 0 },
  };
}
