import handler from "@tanstack/react-start/server-entry";
import { createDb } from "@texfolia/db";

import { collectProjectSources } from "./lib/project-source.server";
import {
  collectTemplateObjects,
  refreshTemplatePreviews,
} from "./lib/template.server";

export { ProjectCollaboration } from "./lib/collaboration/project-collaboration";

export default {
  fetch(request) {
    return handler.fetch(request);
  },
  async scheduled(controller, env) {
    const db = createDb(env.HYPERDRIVE.connectionString);
    try {
      if (controller.cron === "17 * * * *") {
        await collectProjectSources({
          db,
          bucket: env.SOURCES,
          collaboration: env.COLLABORATION,
        });
        await collectTemplateObjects({ db, bucket: env.SOURCES });
      } else await refreshTemplatePreviews({ db, bucket: env.SOURCES });
    } finally {
      await db.$client.end();
    }
  },
} satisfies ExportedHandler<Env>;
