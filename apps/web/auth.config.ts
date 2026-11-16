import { createDb } from "@texfolia/db";

import { assertLocalUrl } from "../../scripts/local-environment.mts";
import { createAuth } from "./src/lib/auth";

assertLocalUrl(process.env.DATABASE_URL, "DATABASE_URL");

export const auth = createAuth(createDb(process.env.DATABASE_URL!));
