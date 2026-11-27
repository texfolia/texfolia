import handler from "@tanstack/react-start/server-entry";
import { createDb, type Db } from "@texfolia/db";

import { gatewayRequestCost } from "#/lib/ai/gateway";
import { reconcileAiUsage } from "#/lib/billing/server";
import { handleBuildQueue } from "#/lib/builds/server";
import { collectGitObjects } from "#/lib/git/server";

import { aiConfig } from "./lib/ai/ai-config.server";
import { collectProjectSources } from "./lib/projects/project-source.server";
import { deleteExpiredProjects } from "./lib/projects/project.server";
import { cspNonceHeader, withSecurityHeaders } from "./lib/security-headers";

export { CompileUsage, ProjectBuilds } from "./lib/builds/server";
export { ProjectCollaboration } from "./lib/collaboration/project-collaboration.server";

// Runs a job on its own Postgres connection so concurrent jobs do not contend
// on a single-connection pool. Jobs that do not need Postgres never open one.
async function withDb<T>(env: Env, job: (db: Db) => Promise<T>) {
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    return await job(db);
  } finally {
    await db.$client.end();
  }
}

// One failing job does not stop the rest.
async function runScheduled(jobs: (() => Promise<unknown>)[]) {
  const results = await Promise.allSettled(jobs.map((job) => job()));
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
  async scheduled(_controller, env) {
    const { SOURCES: bucket, COLLABORATION: collaboration } = env;
    const jobs: (() => Promise<unknown>)[] = [
      () => withDb(env, (db) => deleteExpiredProjects({ db, collaboration })),
      () =>
        withDb(env, (db) =>
          collectProjectSources({ db, bucket, collaboration }),
        ),
      () => withDb(env, (db) => collectGitObjects({ db, bucket })),
    ];
    if (process.env.CLOUDFLARE_AI_API_TOKEN)
      jobs.push(() =>
        withDb(env, async (db) => {
          const config = aiConfig();
          const { retryAfterSeconds } = await reconcileAiUsage({
            db,
            config,
            requestCost: gatewayRequestCost(config),
          });
          if (retryAfterSeconds !== null)
            await env.BACKGROUND.send(
              { kind: "reconcile-ai-usage" },
              { delaySeconds: retryAfterSeconds + 5 },
            );
        }),
      );
    await runScheduled(jobs);
  },
} satisfies ExportedHandler<Env>;
