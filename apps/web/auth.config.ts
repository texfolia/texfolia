import { createDb } from "@texfolia/db";

// Schema generation never connects to Stripe or Postgres.
process.env.STRIPE_SECRET_KEY ??= "sk_test_schema_generation";
const { createAuth } = await import("./src/lib/auth");

export const auth = createAuth(
  createDb("postgresql://schema:schema@127.0.0.1:1/schema"),
);
