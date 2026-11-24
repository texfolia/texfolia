import { createDb } from "@texfolia/db";

import { assertLocalUrl } from "../../scripts/local-environment.mts";
import { createAuth } from "./src/lib/auth/auth";

assertLocalUrl(process.env.DATABASE_URL, "DATABASE_URL");

// Used only by `bun run auth:schema` to generate packages/db/src/auth-schema.ts.
export const auth = createAuth(createDb(process.env.DATABASE_URL!));
