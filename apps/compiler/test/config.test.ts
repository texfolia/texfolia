import { expect, test } from "bun:test";

import { unstable_readConfig } from "wrangler";
import { z } from "zod";

import { poolSettings } from "../src/config";

test.each([
  { env: undefined, suffix: "-local" },
  { env: "production", suffix: "" },
])(
  "compiler $env configuration is a private service with no product bindings",
  ({ env, suffix }) => {
    const config = z
      .object({
        name: z.string(),
        workers_dev: z.boolean(),
        preview_urls: z.boolean(),
        routes: z.array(z.unknown()),
        r2_buckets: z.array(z.unknown()),
        services: z.array(z.unknown()).default([]),
        ratelimits: z.array(z.unknown()).default([]),
        durable_objects: z.object({
          bindings: z.array(z.object({ name: z.string() })),
        }),
        containers: z.array(
          z.object({
            name: z.string(),
            class_name: z.string(),
            max_instances: z.number(),
            instance_type: z.string(),
          }),
        ),
        migrations: z.array(
          z.object({
            tag: z.string(),
            deleted_classes: z.array(z.string()).optional(),
          }),
        ),
        triggers: z.object({ crons: z.array(z.string()) }),
        queues: z.object({
          producers: z.array(z.unknown()).default([]),
          consumers: z.array(z.unknown()).default([]),
        }),
        vars: z.record(z.string(), z.unknown()),
      })
      .parse(
        unstable_readConfig({
          config: new URL("../wrangler.jsonc", import.meta.url).pathname,
          env,
        }),
      );
    expect(config.name).toBe(`texfolia-compiler${suffix}`);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([]);
    expect(config.triggers.crons).toEqual([]);
    expect(config.r2_buckets).toEqual([]);
    expect(config.services).toEqual([]);
    expect(config.ratelimits).toEqual([]);
    expect(config.queues).toEqual({ producers: [], consumers: [] });
    expect(
      config.durable_objects.bindings.map((binding) => binding.name),
    ).toEqual(["COMPILER", "POOL"]);
    expect(config.containers).toHaveLength(1);
    expect(config.containers[0]).toMatchObject({
      name: env
        ? "texfolia-compiler-tectoniccontainer"
        : "texfolia-compiler-local-tectoniccontainer",
      class_name: "TectonicContainer",
      max_instances: 20,
      instance_type: "basic",
    });
    expect(config.migrations.at(-1)).toEqual({
      tag: "v5",
      deleted_classes: ["ProjectCoordinator", "UserCompileUsage"],
    });
    expect(poolSettings(config.vars)).toMatchObject({
      minWarm: 0,
      maxInstances: config.containers[0]?.max_instances,
      concurrency: 1,
      idleMs: 600_000,
    });
  },
);
