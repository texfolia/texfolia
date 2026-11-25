import { expect, test } from "bun:test";

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "./schema";

function indexes(table: PgTable) {
  return getTableConfig(table).indexes.map((index) => index.config.name);
}

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
