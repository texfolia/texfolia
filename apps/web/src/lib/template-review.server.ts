import type { Db } from "@texfolia/db";
import { template, templateReport } from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import { isTemplateReviewer, publicColumns } from "./template-catalog.server";

export async function reportTemplate({
  db,
  userId,
  templateId,
  reason,
}: {
  db: Db;
  userId: string;
  templateId: string;
  reason: string;
}) {
  const [found] = await db
    .select({ id: template.id })
    .from(template)
    .where(and(eq(template.id, templateId), eq(template.status, "approved")));
  if (!found) throw new Error("Template not found");
  await db
    .insert(templateReport)
    .values({ templateId, reporterId: userId, reason })
    .onConflictDoNothing();
}

function ensureReviewer(userId: string, reviewers: string) {
  if (!isTemplateReviewer(userId, reviewers))
    throw new Error("Not authorized to review templates");
}

export async function templateReviewQueue({
  db,
  userId,
  reviewers,
}: {
  db: Db;
  userId: string;
  reviewers: string;
}) {
  ensureReviewer(userId, reviewers);
  const pending = await db
    .select(publicColumns)
    .from(template)
    .where(eq(template.status, "pending"))
    .orderBy(template.createdAt)
    .limit(100);
  const reports = await db
    .select({
      id: templateReport.id,
      templateId: template.id,
      title: template.title,
      reason: templateReport.reason,
      createdAt: templateReport.createdAt,
    })
    .from(templateReport)
    .innerJoin(template, eq(template.id, templateReport.templateId))
    .where(isNull(templateReport.resolvedAt))
    .orderBy(templateReport.createdAt)
    .limit(100);
  return { pending, reports };
}

export async function reviewTemplate({
  db,
  userId,
  reviewers,
  templateId,
  decision,
}: {
  db: Db;
  userId: string;
  reviewers: string;
  templateId: string;
  decision: "approved" | "rejected";
}) {
  ensureReviewer(userId, reviewers);
  await db.transaction(async (tx) => {
    const [found] = await tx
      .select()
      .from(template)
      .where(eq(template.id, templateId))
      .for("update");
    if (!found) throw new Error("Template not found");
    if (found.ownerId === userId)
      throw new Error("Another reviewer must review your template");
    await tx
      .update(template)
      .set({ status: decision })
      .where(eq(template.id, templateId));
    await tx
      .update(templateReport)
      .set({ resolvedAt: new Date() })
      .where(eq(templateReport.templateId, templateId));
  });
}
