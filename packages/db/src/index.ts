import { defineRelationsPart } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { authRelations, subscription, verification } from "./db/auth-schema";
import { relations } from "./db/schema";

// The generator omits tables without foreign keys from the relations callback.
const standaloneAuthRelations = defineRelationsPart(
  { subscription, verification },
  () => ({ subscription: {}, verification: {} }),
);

export function createDb(connectionString: string) {
  const client = new Pool({ connectionString, max: 5 });

  return drizzle({
    client,
    relations: { ...relations, ...authRelations, ...standaloneAuthRelations },
  });
}

export type Db = ReturnType<typeof createDb>;
