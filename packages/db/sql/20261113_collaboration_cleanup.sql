BEGIN;

CREATE TABLE IF NOT EXISTS "project_collaboration" (
  "project_id" uuid PRIMARY KEY
);

-- Existing rooms may be clean and have no alarm. Register their projects too.
INSERT INTO "project_collaboration" ("project_id")
SELECT "id" FROM "project"
ON CONFLICT DO NOTHING;

COMMIT;
