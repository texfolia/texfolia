import handler from "@tanstack/react-start/server-entry";
import { reconcileAiUsage } from "@texfolia/billing/server";
import { createDb } from "@texfolia/db";
import { collectGitObjects } from "@texfolia/git/server";
import { sweepProjectSources } from "@texfolia/storage/server";

import { aiConfig, gatewayRequestCost } from "./lib/ai/gateway.server";
import { collectProjectSources } from "./lib/project-source.server";
import { cspNonceHeader, withSecurityHeaders } from "./lib/security-headers";
import { collectTemplateObjects } from "./lib/template-cleanup.server";
import { refreshTemplatePreviews } from "./lib/template-preview.server";

export { ProjectCollaboration } from "./lib/project-collaboration.server";

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
