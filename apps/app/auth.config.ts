import { createDb } from "@texfolia/db";

import { assertLocalUrl } from "../../scripts/local-environment.mts";
import { createAuth } from "./src/features/auth/auth";

assertLocalUrl(process.env.DATABASE_URL, "DATABASE_URL");

// Prefer `bun run --cwd packages/auth auth:schema` for schema generation.
// This config remains for local app-level auth tooling.
export const auth = createAuth(createDb(process.env.DATABASE_URL!));
