import type { Db } from "@texfolia/db";
import { template } from "@texfolia/db/schema";
import type { SourceBucket } from "@texfolia/storage/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { templateSnapshotSchema } from "./template.schema";

type Context = { db: Db; bucket: SourceBucket };
export async function collectTemplateObjects({
  db,
  bucket,
  olderThan = new Date(Date.now() - 60 * 60_000),
}: Context & { olderThan?: Date }) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: "templates/",
      cursor,
      limit: 100,
    });
    const ids = new Set(
      page.objects
        .filter((object) => object.uploaded < olderThan)
        .flatMap((object) => {
          const parsed = z.uuid().safeParse(object.key.split("/")[1]);
          return parsed.success ? [parsed.data] : [];
        }),
    );
    for (const templateId of ids)
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${templateId}, 0))`,
        );
        const [found] = await tx
          .select({
            snapshot: template.snapshot,
            previewKey: template.previewKey,
          })
          .from(template)
          .where(eq(template.id, templateId));
        const referenced = new Set(
          found
            ? [
                found.previewKey,
                ...templateSnapshotSchema
                  .parse(found.snapshot)
                  .map((node) => node.objectKey),
              ]
            : [],
        );
        const garbage = page.objects.filter(
          (object) =>
            object.uploaded < olderThan &&
            object.key.startsWith(`templates/${templateId}/`) &&
            !referenced.has(object.key),
        );
        if (garbage.length)
          await bucket.delete(garbage.map((object) => object.key));
      });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
