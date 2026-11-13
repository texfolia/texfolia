BEGIN;

ALTER TABLE "project" ADD COLUMN "organization_id" text REFERENCES "organization"("id") ON DELETE CASCADE;
ALTER TABLE "project" ALTER COLUMN "owner_id" DROP NOT NULL;
ALTER TABLE "project" ADD CONSTRAINT "project_owner_check" CHECK (("owner_id" IS NOT NULL AND "organization_id" IS NULL) OR ("owner_id" IS NULL AND "organization_id" IS NOT NULL));
CREATE INDEX "project_organization_id_idx" ON "project" ("organization_id");

CREATE TYPE "template_visibility" AS ENUM ('public', 'unlisted');
CREATE TYPE "template_status" AS ENUM ('building', 'pending', 'approved', 'rejected', 'failed');
CREATE TYPE "template_license" AS ENUM ('CC0-1.0', 'CC-BY-4.0', 'MIT', 'LPPL-1.3c');

CREATE TABLE "template" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "organization_id" text REFERENCES "organization"("id") ON DELETE CASCADE,
  "publisher_name" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "tags" text[] NOT NULL,
  "license" "template_license" NOT NULL,
  "visibility" "template_visibility" NOT NULL,
  "status" "template_status" NOT NULL DEFAULT 'building',
  "main_file" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "preview_key" text,
  "preview_checked_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "template_ready_preview_check" CHECK ("status" NOT IN ('approved', 'pending') OR "preview_key" IS NOT NULL)
);
CREATE INDEX "template_gallery_idx" ON "template" ("visibility", "status", "created_at");
CREATE INDEX "template_publisher_idx" ON "template" ("owner_id", "created_at");
CREATE INDEX "template_preview_queue_idx" ON "template" ("status", "preview_checked_at", "created_at");

CREATE TABLE "template_report" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id" uuid NOT NULL REFERENCES "template"("id") ON DELETE CASCADE,
  "reporter_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "reason" text NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "template_report_per_user" UNIQUE ("template_id", "reporter_id")
);
CREATE INDEX "template_report_queue_idx" ON "template_report" ("resolved_at", "created_at");

COMMIT;
