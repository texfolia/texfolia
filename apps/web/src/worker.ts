import handler from "@tanstack/react-start/server-entry";
import { createDb } from "@texfolia/db";

import { collectProjectSources } from "./lib/project-source.server";

export default {
  fetch(request) {
    return handler.fetch(request);
  },
  async scheduled(_controller, env) {
    const db = createDb(env.HYPERDRIVE.connectionString);
    try {
      await collectProjectSources({ db, bucket: env.SOURCES });
    } finally {
      await db.$client.end();
    }
  },
} satisfies ExportedHandler<Env>;
