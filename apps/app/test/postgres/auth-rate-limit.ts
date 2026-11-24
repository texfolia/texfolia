import assert from "node:assert/strict";

import { createDb } from "@texfolia/db";
import { rateLimit } from "@texfolia/db/schema";
import { like } from "drizzle-orm";

import { createAuth } from "../../src/lib/auth/auth";

const env = {
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "auth-rate-limit-integration-test-secret-32",
  STRIPE_SECRET_KEY: "sk_test_auth_rate_limit",
  TURNSTILE_SECRET: "turnstile-test-secret",
  TURNSTILE_HOSTNAMES: "localhost",
};

/** Separate auth instances stand in for Worker isolates sharing one database. */
export async function checkAuthRateLimit(connectionString: string) {
  const previous = Object.keys(env).map(
    (key) => [key, process.env[key]] as const,
  );
  Object.assign(process.env, env);
  const dbs = Array.from({ length: 8 }, () => createDb(connectionString));
  const ip = `2001:db8:${crypto.randomUUID().slice(0, 4)}::1`;
  try {
    const statuses = await Promise.all(
      dbs.map(async (db) => {
        const response = await createAuth(db).handler(
          new Request(
            "http://localhost:3000/api/auth/email-otp/check-verification-otp",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: "http://localhost:3000",
                "cf-connecting-ip": ip,
              },
              body: JSON.stringify({
                email: "unknown@example.com",
                otp: "000000",
                type: "sign-in",
              }),
            },
          ),
        );
        return response.status;
      }),
    );
    assert.equal(
      statuses.filter((status) => status !== 429).length,
      3,
      `parallel first requests share one limit: ${statuses.join(", ")}`,
    );
    assert(!statuses.includes(500));
  } finally {
    await dbs[0]
      ?.delete(rateLimit)
      .where(like(rateLimit.key, "%check-verification-otp"));
    await Promise.all(dbs.map((db) => db.$client.end()));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
