import type { Db } from "@texfolia/db";
import { template } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";

import type { ProjectTransaction } from "#/lib/projects/server";

import { managesTemplate } from "./catalog.server";

type Request = { db: Db; userId: string; templateId: string };

async function lockManaged(
  tx: ProjectTransaction,
  { userId, templateId }: Omit<Request, "db">,
) {
  const [found] = await tx
    .select()
    .from(template)
    .where(eq(template.id, templateId))
    .for("update");
  if (!found || !(await managesTemplate(tx, found, userId)))
    throw new Error("Template not found");
  return found;
}

/**
 * Hides a template from everyone but its publisher and reviewers, or shows it
 * again. The snapshot cannot change, so its review still stands.
 */
export async function setTemplatePublished({
  db,
  userId,
  templateId,
  published,
}: Request & { published: boolean }) {
  await db.transaction(async (tx) => {
    const found = await lockManaged(tx, { userId, templateId });
    if (!found.unpublishedAt === published) return;
    await tx
      .update(template)
      .set({ unpublishedAt: published ? null : new Date() })
      .where(eq(template.id, templateId));
  });
}

/**
 * Deletes a template. Projects made from it are independent copies. Its stored
 * files are collected later, like those of any template without a row.
 */
export async function deleteTemplate({ db, userId, templateId }: Request) {
  await db.transaction(async (tx) => {
    await lockManaged(tx, { userId, templateId });
    await tx.delete(template).where(eq(template.id, templateId));
  });
}
