BEGIN;

ALTER TABLE "project_job"
  ADD COLUMN IF NOT EXISTS "request_digest" text;

COMMIT;
