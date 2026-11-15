import { eq, sql } from "drizzle-orm";
import { seed } from "drizzle-seed";

import type { Db } from "./index";
import { template } from "./schema";
import { starterLicense, templateStarters } from "./template-starters";

async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function seedId(value: string) {
  const hash = await digest(`texfolia-starter:v2:${value}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function seedTemplates({
  db,
  putSource,
}: {
  db: Db;
  putSource: (key: string, bytes: Uint8Array) => Promise<unknown>;
}) {
  const results = [];
  for (const starter of templateStarters) {
    const id = await seedId(starter.slug);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`,
      );
      const [existing] = await tx
        .select({ id: template.id })
        .from(template)
        .where(eq(template.id, id));
      if (existing) return;
      const rootId = await seedId(`${starter.slug}:root`);
      const snapshot: {
        id: string;
        parentId: string | null;
        name: string;
        kind: "folder" | "text";
        objectKey: string | null;
        sizeBytes: number;
      }[] = [
        {
          id: rootId,
          parentId: null,
          name: starter.title,
          kind: "folder",
          objectKey: null,
          sizeBytes: 0,
        },
      ];
      for (const file of [
        { name: "main.tex", content: starter.source },
        { name: "LICENSE.txt", content: starterLicense },
      ]) {
        const bytes = new TextEncoder().encode(file.content);
        const objectKey = `templates/${id}/sources/${await digest(file.content)}`;
        await putSource(objectKey, bytes);
        snapshot.push({
          id: await seedId(`${starter.slug}:${file.name}`),
          parentId: rootId,
          name: file.name,
          kind: "text",
          objectKey,
          sizeBytes: bytes.byteLength,
        });
      }
      // One explicit row per seed keeps every column paired with its original source.
      await seed(tx, { template }, { count: 1 }).refine((f) => ({
        template: {
          columns: {
            id: f.default({ defaultValue: id }),
            ownerId: f.default({ defaultValue: null }),
            organizationId: f.default({ defaultValue: null }),
            publisherName: f.default({ defaultValue: "Texfolia" }),
            title: f.default({ defaultValue: starter.title }),
            description: f.default({ defaultValue: starter.description }),
            tags: f.default({ defaultValue: starter.tags }),
            license: f.default({ defaultValue: "CC0-1.0" }),
            visibility: f.default({ defaultValue: "public" }),
            status: f.default({ defaultValue: "approved" }),
            mainFile: f.default({ defaultValue: "main.tex" }),
            snapshot: f.default({ defaultValue: snapshot }),
            previewKey: f.default({ defaultValue: null }),
            previewStatus: f.default({ defaultValue: "queued" }),
            previewJobId: f.default({ defaultValue: crypto.randomUUID() }),
            previewStartedAt: f.default({ defaultValue: new Date() }),
            previewNextAttemptAt: f.default({ defaultValue: new Date() }),
            error: f.default({ defaultValue: null }),
            createdAt: f.default({ defaultValue: new Date() }),
          },
        },
      }));
    });
    results.push({ id, title: starter.title });
  }
  return results;
}
