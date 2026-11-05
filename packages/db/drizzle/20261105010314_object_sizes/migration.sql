-- Leave old object sizes unknown until the R2 HEAD backfill can measure them.
ALTER TABLE "project_node" ADD COLUMN "size_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "project_job" ADD COLUMN "size_bytes" bigint;
--> statement-breakpoint
UPDATE "project_node" SET "size_bytes" = 0 WHERE "object_key" IS NULL;
--> statement-breakpoint
UPDATE "project_job" SET "size_bytes" = 0 WHERE "object_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "project_node" ADD CONSTRAINT "project_node_object_size_check"
  CHECK ("size_bytes" >= 0 AND ("object_key" IS NOT NULL OR "size_bytes" = 0));
--> statement-breakpoint
ALTER TABLE "project_job" ADD CONSTRAINT "project_job_object_size_check"
  CHECK ("size_bytes" >= 0 AND ("object_key" IS NOT NULL OR "size_bytes" = 0));
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;
