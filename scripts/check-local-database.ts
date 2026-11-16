import { assertLocalUrl } from "./local-environment.mts";

assertLocalUrl(process.env.DATABASE_URL, "DATABASE_URL");
