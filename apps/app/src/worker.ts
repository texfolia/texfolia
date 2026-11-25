import handler from "@tanstack/react-start/server-entry";
import { createDb, type Db } from "@texfolia/db";

import { gatewayRequestCost } from "#/lib/ai/gateway";
import { reconcileAiUsage } from "#/lib/billing/server";
import { handleBuildQueue } from "#/lib/builds/server";
import { collectGitObjects, collectLegacyHistory } from "#/lib/git/server";
import { sweepProjectSources } from "#/lib/storage/server";
import {
  collectTemplateObjects,
  refreshTemplatePreviews,
} from "#/lib/templates/server";

import { aiConfig } from "./lib/ai/ai-config.server";
import { collectProjectSources } from "./lib/projects/project-source.server";
import { deleteExpiredProjects } from "./lib/projects/project.server";
import { cspNonceHeader, withSecurityHeaders } from "./lib/security-headers";

export { CompileUsage, ProjectBuilds } from "./lib/builds/server";
export { ProjectCollaboration } from "./lib/collaboration/project-collaboration.server";

// Runs each job on its own connection: jobs sharing a pool of one would wait for
// each other's queries and transactions. One failing does not stop the rest.
async function runScheduled(env: Env, jobs: ((db: Db) => Promise<unknown>)[]) {
  const results = await Promise.allSettled(
    jobs.map(async (job) => {
      const db = createDb(env.HYPERDRIVE.connectionString);
      try {
        await job(db);
      } finally {
        await db.$client.end();
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "Scheduled maintenance failed");
}

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
  queue: handleBuildQueue,
  async scheduled(controller, env) {
    const { SOURCES: bucket, COLLABORATION: collaboration } = env;
    if (controller.cron === "17 * * * *")
      await runScheduled(env, [
        (db) => deleteExpiredProjects({ db, collaboration }),
        (db) => collectProjectSources({ db, bucket, collaboration }),
        (db) => collectGitObjects({ db, bucket }),
        () => collectLegacyHistory(bucket),
        (db) => collectTemplateObjects({ db, bucket }),
      ]);
    else if (controller.cron === "41 3 * * *")
      await runScheduled(env, [(db) => sweepProjectSources({ db, bucket })]);
    else
      await runScheduled(env, [
        (db) => refreshTemplatePreviews({ db, bucket }),
        async (db) => {
          if (!process.env.CLOUDFLARE_AI_API_TOKEN) return;
          const config = aiConfig();
          await reconcileAiUsage({
            db,
            config,
            requestCost: gatewayRequestCost(config),
          });
        },
      ]);
  },
} satisfies ExportedHandler<Env>;
