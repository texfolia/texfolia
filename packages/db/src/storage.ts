import { type SQL, sql } from "drizzle-orm";

import { db } from "./index";

async function storageBytes(scope: SQL): Promise<bigint> {
  const result = await db.execute<{
    total: string;
    incomplete: boolean | null;
  }>(sql`
    WITH active_projects AS (
      SELECT id FROM project WHERE deleted_at IS NULL AND ${scope}
    ), objects AS (
      SELECT size_bytes FROM project_node JOIN active_projects ON project_id = active_projects.id
      WHERE project_node.deleted_at IS NULL AND object_key IS NOT NULL
      UNION ALL
      SELECT size_bytes FROM project_job JOIN active_projects ON project_id = active_projects.id
      WHERE object_key IS NOT NULL
    )
    SELECT coalesce(sum(size_bytes), 0)::text AS total, bool_or(size_bytes IS NULL) AS incomplete
    FROM objects
  `);
  const row = result.rows[0];
  if (row?.incomplete) throw new Error("Object size backfill is incomplete");
  return BigInt(row?.total ?? "0");
}

export function getProjectStorageBytes(projectId: string) {
  return storageBytes(sql`id = ${projectId}`);
}

export function getUserStorageBytes(userId: string) {
  return storageBytes(sql`owner_id = ${userId}`);
}
