import { expect, test } from "bun:test";

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "./schema";
import * as aiSchema from "./schema/ai";
import * as auditSchema from "./schema/audit";
import * as commentsSchema from "./schema/comments";
import * as projectsSchema from "./schema/projects";
import * as sharingSchema from "./schema/sharing";

function indexes(table: PgTable) {
  return getTableConfig(table).indexes.map((index) => index.config.name);
}

function tableNames(mod: Record<string, unknown>) {
  return Object.values(mod)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableConfig(table).name)
    .toSorted();
}

test("all tables remain in the default public schema", () => {
  const namespaced: string[] = [];
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable)) continue;
    const config = getTableConfig(table);
    if (config.schema !== undefined)
      namespaced.push(`${config.schema}.${config.name}`);
  }
  expect(namespaced).toEqual([]);
});

test("feature modules can be imported in isolation and compose into the barrel", () => {
  const barrelTables = new Set(tableNames(schema));
  for (const feature of [
    projectsSchema,
    sharingSchema,
    commentsSchema,
    aiSchema,
    auditSchema,
  ]) {
    const names = tableNames(feature);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(barrelTables.has(name)).toBe(true);
  }
});

// `bun run auth:schema` regenerates auth-schema.ts without these.
test("hand-written auth indexes survive schema generation", () => {
  expect(indexes(schema.user)).toEqual([
    "user_email_lower_idx",
    "user_stripeCustomerId_idx",
  ]);
  expect(indexes(schema.organization)).toContain(
    "organization_stripeCustomerId_idx",
  );
  expect(indexes(schema.invitation)).toContain("invitation_inviterId_idx");
  expect(indexes(schema.subscription)).toEqual([
    "subscription_referenceId_idx",
    "subscription_stripeCustomerId_idx",
    "subscription_stripeSubscriptionId_idx",
  ]);
});

// Deleting a referenced row scans every referencing table that has no index.
test("every foreign key has an index that leads with its columns", () => {
  const missing: string[] = [];
  let checked = 0;
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable)) continue;
    const config = getTableConfig(table);
    const leading = new Set([
      ...config.columns.flatMap((c) =>
        c.primary || c.isUnique ? [c.name] : [],
      ),
      ...config.primaryKeys.map((key) => key.columns[0]?.name),
      ...config.uniqueConstraints.map((unique) => unique.columns[0]?.name),
      // A partial index cannot serve a cascade.
      ...config.indexes.flatMap(({ config: { columns, where } }) => {
        const [first] = columns;
        return !where && first && "name" in first ? [first.name] : [];
      }),
    ]);
    for (const key of config.foreignKeys) {
      checked++;
      const [column] = key.reference().columns;
      if (column && !leading.has(column.name))
        missing.push(`${config.name}.${column.name}`);
    }
  }
  expect(checked).toBeGreaterThan(30);
  expect(missing).toEqual([]);
});
