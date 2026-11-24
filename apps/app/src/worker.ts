import handler from "@tanstack/react-start/server-entry";
import { createDb } from "@texfolia/db";

import { gatewayRequestCost } from "#/features/ai/gateway";
import { reconcileAiUsage } from "#/features/billing/server";
import { collectGitObjects } from "#/features/git/server";
import { sweepProjectSources } from "#/features/storage/server";
import {
  collectTemplateObjects,
  refreshTemplatePreviews,
} from "#/features/templates/server";

import { aiConfig } from "./features/ai/ai-config.server";
import { collectProjectSources } from "./features/projects/project-source.server";
import { deleteExpiredProjects } from "./features/projects/project.server";
import { cspNonceHeader, withSecurityHeaders } from "./lib/security-headers";

export { ProjectCollaboration } from "./features/collaboration/project-collaboration.server";

export default {
  async fetch(request) {
    const nonce = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    );
    const headers = new Headers(request.headers);
    // Always replace a client-supplied value before the router reads it.
    headers.set(cspNonceHeader, nonce);
    const response = await handler.fetch(new Request(request, { headers }));
    return withSecurityHeaders({
      response,
      nonce,
      url: request.url,
      development: import.meta.env.DEV,
    });
  },
  async scheduled(controller, env) {
    const db = createDb(env.HYPERDRIVE.connectionString);
    try {
      if (controller.cron === "17 * * * *") {
        await deleteExpiredProjects({ db, collaboration: env.COLLABORATION });
        await collectProjectSources({
          db,
          bucket: env.SOURCES,
          collaboration: env.COLLABORATION,
        });
        await collectGitObjects({ db, bucket: env.SOURCES });
        await collectTemplateObjects({ db, bucket: env.SOURCES });
      } else if (controller.cron === "41 3 * * *") {
        await sweepProjectSources({ db, bucket: env.SOURCES });
      } else {
        const results = await Promise.allSettled([
          refreshTemplatePreviews({ db, bucket: env.SOURCES }),
          Promise.resolve().then(() => {
            if (!process.env.CLOUDFLARE_AI_API_TOKEN) return;
            const config = aiConfig();
            return reconcileAiUsage({
              db,
              config,
              requestCost: gatewayRequestCost(config),
            });
          }),
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
