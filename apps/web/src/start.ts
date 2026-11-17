import { createMiddleware, createStart } from "@tanstack/react-start";
import { createDb } from "@texfolia/db";
import { env } from "cloudflare:workers";

import { createAuth } from "./lib/auth";

const requestContext = createMiddleware().server(async ({ next }) => {
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    const auth = createAuth(db, env.COLLABORATION);
    return await next({ context: { auth, db } });
  } finally {
    await db.$client.end();
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [requestContext],
}));

declare module "@tanstack/react-start" {
  interface Register {
    config: Awaited<ReturnType<typeof startInstance.getOptions>>;
  }
}
