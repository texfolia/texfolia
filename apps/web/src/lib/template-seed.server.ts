import type { Db } from "@texfolia/db";
import { project, projectNode, user } from "@texfolia/db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { hashSource } from "./latex/source-sync";
import type { SourceBucket } from "./project-source.server";
import { starterLicense, templateStarters } from "./template-starters";
import { isTemplateReviewer, publishTemplate } from "./template.server";

async function seedId(key: string) {
  const hash = await hashSource(new TextEncoder().encode(key));
  return z
    .uuid()
    .parse(
      `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    );
}

export async function seedTemplateStarters({
  db,
  bucket,
  userId,
  reviewers,
}: {
  db: Db;
  bucket: SourceBucket;
  userId: string;
  reviewers: string;
}) {
  if (!isTemplateReviewer(userId, reviewers))
    throw new Error("Not authorized to seed templates");
  const results: { id: string; title: string }[] = [];
  for (const starter of templateStarters) {
    const projectId = await seedId(
      `texfolia-starter:v1:${userId}:${starter.slug}:project`,
    );
    const templateId = await seedId(
      `texfolia-starter:v1:${userId}:${starter.slug}:template`,
    );
    await db.transaction(async (tx) => {
      const [publisher] = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, userId))
        .for("update");
      if (!publisher) throw new Error("Unauthorized");
      const [existing] = await tx
        .select({ id: project.id })
        .from(project)
        .where(eq(project.id, projectId));
      if (existing) return;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`,
      );
      await tx.insert(project).values({
        id: projectId,
        ownerId: userId,
        name: `${starter.title} (starter ${projectId.slice(0, 8)})`,
      });
      const rootId = crypto.randomUUID();
      await tx.insert(projectNode).values({
        id: rootId,
        projectId,
        parentId: null,
        name: starter.title,
        kind: "folder",
        sizeBytes: 0n,
      });
      for (const file of [
        { name: "main.tex", content: starter.source },
        { name: "LICENSE.txt", content: starterLicense },
      ]) {
        const bytes = new TextEncoder().encode(file.content);
        const objectKey = `projects/${projectId}/sources/${await hashSource(bytes)}`;
        await bucket.put(objectKey, bytes);
        await tx.insert(projectNode).values({
          projectId,
          parentId: rootId,
          name: file.name,
          kind: "text",
          objectKey,
          sizeBytes: BigInt(bytes.byteLength),
        });
      }
    });
    const published = await publishTemplate({
      db,
      bucket,
      userId,
      templateId,
      data: {
        projectId,
        title: starter.title,
        description: starter.description,
        mainFile: "main.tex",
        tags: starter.tags,
        license: "CC0-1.0",
        visibility: "public",
        redistributionConfirmed: true,
      },
    });
    results.push({ ...published, title: starter.title });
  }
  return results;
}
