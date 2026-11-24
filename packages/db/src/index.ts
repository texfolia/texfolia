import { defineRelationsPart } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  authRelations,
  rateLimit,
  subscription,
  verification,
} from "./auth-schema";
import { relations } from "./schema";

// The generator omits tables without foreign keys from the relations callback.
const standaloneAuthRelations = defineRelationsPart(
  { rateLimit, subscription, verification },
  () => ({ rateLimit: {}, subscription: {}, verification: {} }),
);

// Each db serves one request or operation, and Hyperdrive pools connections
// upstream, so one connection is enough. A pool (rather than a bare Client)
// still connects lazily and keeps transactions isolated from other queries.
export function createDb(connectionString: string) {
  const client = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
  });

  return drizzle({
    client,
    relations: { ...relations, ...authRelations, ...standaloneAuthRelations },
  });
}

export type Db = ReturnType<typeof createDb>;
