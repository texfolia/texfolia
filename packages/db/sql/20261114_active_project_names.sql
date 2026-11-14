BEGIN;

DROP INDEX "project_owner_id_name_idx";
CREATE UNIQUE INDEX "project_owner_id_name_idx"
  ON "project" ("owner_id", "name")
  WHERE "deleted_at" IS NULL;

COMMIT;
