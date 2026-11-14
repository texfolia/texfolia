import assert from "node:assert/strict";

import { Client } from "pg";

const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Set INTEGRATION_DATABASE_URL to an isolated Postgres test database",
);
const client = new Client({ connectionString });
const schema = `project_names_${crypto.randomUUID().replaceAll("-", "")}`;
const ownerId = crypto.randomUUID();
const migration = await Bun.file(
  new URL("../sql/20261114_active_project_names.sql", import.meta.url),
).text();

await client.connect();
try {
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE project (LIKE public.project INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
    CREATE UNIQUE INDEX project_owner_id_name_idx ON project (owner_id, name);
  `);
  await client.query(
    `INSERT INTO project (owner_id, name, deleted_at)
     VALUES ($1, 'Active', NULL), ($1, 'Deleted', now())`,
    [ownerId],
  );
  const before = await client.query("SELECT * FROM project ORDER BY id");
  const duplicate = () =>
    client.query(
      "INSERT INTO project (owner_id, name) VALUES ($1, 'Deleted')",
      [ownerId],
    );
  await assert.rejects(duplicate(), { code: "23505" });

  await client.query(migration);
  assert.deepEqual(
    (await client.query("SELECT * FROM project ORDER BY id")).rows,
    before.rows,
    "The migration preserves active and deleted rows",
  );
  await duplicate();
  await assert.rejects(duplicate(), {
    code: "23505",
    constraint: "project_owner_id_name_idx",
  });
  await assert.rejects(
    client.query("INSERT INTO project (owner_id, name) VALUES ($1, 'Active')", [
      ownerId,
    ]),
    { code: "23505" },
  );

  const after = await client.query("SELECT * FROM project ORDER BY id");
  await client.query(migration);
  assert.deepEqual(
    (await client.query("SELECT * FROM project ORDER BY id")).rows,
    after.rows,
    "Reapplying the migration preserves a reused name and its deleted history",
  );
  await assert.rejects(duplicate(), { code: "23505" });
  console.log(
    "Project name migration passed: legacy upgrade, retained history, name reuse, active uniqueness, and reapplication",
  );
} finally {
  await client.query("ROLLBACK");
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
}
