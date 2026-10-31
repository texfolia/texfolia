import { drizzle } from "drizzle-orm/bun-sql";

import { authRelations } from "./db/auth-schema";
import { relations } from "./db/schema";

export const db = drizzle(process.env.DATABASE_URL!, {
  relations: { ...relations, ...authRelations },
});
