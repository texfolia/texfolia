import { createMiddleware, createStart } from "@tanstack/react-start";
import { createDb } from "@texfolia/db";
import { env } from "cloudflare:workers";

import { createAuth } from "./lib/auth";

const requestContext = createMiddleware().server(({ next }) => {
  const db = createDb(env.HYPERDRIVE.connectionString);

  const auth = createAuth(db);

  return next({ context: { auth, db } });
});

export const startInstance = createStart(() => ({
  requestMiddleware: [requestContext],
}));

declare module "@tanstack/react-start" {
  interface Register {
    config: Awaited<ReturnType<typeof startInstance.getOptions>>;
  }
}
