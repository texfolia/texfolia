import { drizzle } from "drizzle-orm/node-postgres";

import { authRelations } from "./db/auth-schema";
import { relations } from "./db/schema";

export * from "./db/auth-schema";
export * from "./db/schema";

export const db = drizzle(process.env.DATABASE_URL!, {
  relations: { ...relations, ...authRelations },
});
