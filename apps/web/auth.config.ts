import { createDb } from "@texfolia/db";

import { createAuth } from "./src/lib/auth";

export const auth = createAuth(createDb(process.env.DATABASE_URL!));
