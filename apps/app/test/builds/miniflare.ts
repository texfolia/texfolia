import { convertV4MiniflareOptions } from "miniflare";

type Options = Parameters<typeof convertV4MiniflareOptions>[0];
type WorkerOptions = Exclude<Options, { workers: unknown }>;
type Service = NonNullable<WorkerOptions["serviceBindings"]>[string];

const fixtureScript = `
import { DurableObject } from "cloudflare:workers";
export class ProjectBuilds extends DurableObject {
  fetch(request) {
    return this.env.HANDLER.fetch(request);
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };
`;

/**
 * Options for a Worker whose `BUILDS` binding answers with `handler`, in place
 * of real build coordinators. Requests keep their `/projects/<id>/...` paths.
 */
export function withBuildsFixture(options: WorkerOptions, handler: Service) {
  const converted = convertV4MiniflareOptions({
    ...options,
    durableObjects: {
      ...options.durableObjects,
      BUILDS: { className: "ProjectBuilds", scriptName: "builds-fixture" },
    },
  });
  const fixture = convertV4MiniflareOptions({
    name: "builds-fixture",
    modules: true,
    script: fixtureScript,
    compatibilityDate: "2026-10-30",
    durableObjects: { BUILDS: "ProjectBuilds" },
    serviceBindings: { HANDLER: handler },
  });
  return {
    ...converted,
    workers: [...(converted.workers ?? []), ...(fixture.workers ?? [])],
  };
}

const overflow = {
  maxBatchSize: 1,
  maxBatchTimeout: 0,
  maxRetries: 1,
  deadLetterQueue: "compile-dlq",
};

/** Every binding the real build coordinators use, as `wrangler.jsonc` does. */
export const buildsBindings = {
  durableObjects: {
    BUILDS: { className: "ProjectBuilds", useSQLite: true as const },
    COMPILE_USAGE: { className: "CompileUsage", useSQLite: true as const },
  },
  r2Buckets: ["SOURCES", "BUILD_ARTIFACTS"],
  ratelimits: {
    COMPILE_LIMIT: {
      namespace_id: "244",
      simple: { limit: 2, period: 10 as const },
    },
  },
  queueProducers: {
    COMPILE_PRO: "compile-pro",
    COMPILE_FREE: "compile-free",
    BACKGROUND: "background",
  },
  queueConsumers: {
    "compile-pro": overflow,
    "compile-free": overflow,
    "compile-dlq": { maxBatchSize: 10, maxBatchTimeout: 5 },
    background: { maxBatchSize: 20, maxBatchTimeout: 5 },
  },
} satisfies Partial<WorkerOptions>;
