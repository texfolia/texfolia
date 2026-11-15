import handler from "@tanstack/react-start/server-entry";
import { createDb } from "@texfolia/db";

import { reconcileAiUsage } from "./lib/ai/billing.server";
import { aiConfig } from "./lib/ai/gateway.server";
import { collectGitObjects } from "./lib/git.server";
import { collectProjectSources } from "./lib/project-source.server";
import { collectTemplateObjects } from "./lib/template-cleanup.server";
import { refreshTemplatePreviews } from "./lib/template-preview.server";

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
        await collectGitObjects({ db, bucket: env.SOURCES });
        await collectTemplateObjects({ db, bucket: env.SOURCES });
      } else {
        const results = await Promise.allSettled([
          refreshTemplatePreviews({ db, bucket: env.SOURCES }),
          Promise.resolve().then(() =>
            process.env.CLOUDFLARE_AI_API_TOKEN
              ? reconcileAiUsage({ db, config: aiConfig() })
              : undefined,
          ),
        ]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "Scheduled maintenance failed");
      }
    } finally {
      await db.$client.end();
    }
  },
} satisfies ExportedHandler<Env>;
