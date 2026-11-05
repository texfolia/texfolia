import { S3Client } from "bun";
import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { db, projectJob, projectNode } from "../src";

function bucket(name: string | undefined) {
  if (!name || !process.env.S3_ENDPOINT)
    throw new Error("Set S3_ENDPOINT and the bucket for each object type.");
  return new S3Client({
    bucket: name,
    endpoint: process.env.S3_ENDPOINT,
    region: "auto",
  });
}

const pdfs = bucket(process.env.R2_PDF_BUCKET);
const files = bucket(process.env.R2_FILE_BUCKET ?? process.env.R2_PDF_BUCKET);
let failures = 0;
for (const [table, storage] of [
  [projectNode, files],
  [projectJob, pdfs],
] as const) {
  for (;;) {
    const rows = await db
      .select({ id: table.id, key: table.objectKey })
      .from(table)
      .where(isNull(table.sizeBytes))
      .limit(100);
    if (!rows.length) break;
    let updated = 0;
    for (const row of rows) {
      try {
        const size =
          row.key === null ? 0n : BigInt((await storage.stat(row.key)).size);
        await db
          .update(table)
          .set({ sizeBytes: size })
          .where(
            and(
              eq(table.id, row.id),
              isNull(table.sizeBytes),
              row.key === null
                ? isNull(table.objectKey)
                : eq(table.objectKey, row.key),
            ),
          );
        updated++;
      } catch (error) {
        console.error("Could not read object size", {
          table: table === projectJob ? "project_job" : "project_node",
          id: row.id,
          error,
        });
        failures++;
      }
    }
    if (updated < rows.length) break;
  }
}

// A network failure can leave an older job running after the Worker stored its PDF.
const stale = new Date(Date.now() - 5 * 60_000);
const jobs = await db
  .select({ id: projectJob.id })
  .from(projectJob)
  .where(
    and(
      eq(projectJob.status, "running"),
      isNull(projectJob.objectKey),
      lt(projectJob.startedAt, stale),
    ),
  );
for (const { id } of jobs) {
  const key = `compilations/${id}.pdf`;
  try {
    const result = (await pdfs.exists(key)) ? await pdfs.stat(key) : null;
    await db
      .update(projectJob)
      .set(
        result
          ? {
              status: "succeeded",
              objectKey: key,
              sizeBytes: BigInt(result.size),
              finishedAt: new Date(),
            }
          : {
              status: "failed",
              error: "Compiler did not return a result",
              finishedAt: new Date(),
            },
      )
      .where(
        and(
          eq(projectJob.id, id),
          eq(projectJob.status, "running"),
          isNull(projectJob.objectKey),
        ),
      );
  } catch (error) {
    console.error("Could not reconcile compile job", { id, error });
    failures++;
  }
}

if (failures)
  throw new Error(
    `${failures} object checks failed. Resolve them and rerun the script.`,
  );

if (process.argv.includes("--finalize")) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`ALTER TABLE project_node ALTER COLUMN size_bytes SET NOT NULL`,
    );
    await tx.execute(
      sql`ALTER TABLE project_job ALTER COLUMN size_bytes SET NOT NULL`,
    );
  });
}
