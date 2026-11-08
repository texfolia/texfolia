import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { authRelations } from "./db/auth-schema";
import { relations } from "./db/schema";

export function createDb(connectionString: string) {
  const client = new Pool({ connectionString, max: 5 });

  return drizzle({
    client,
    relations: { ...relations, ...authRelations },
  });
}

export type Db = ReturnType<typeof createDb>;
