import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import ts from "typescript";
import { getPlatformProxy } from "wrangler";
import { z } from "zod";

import { assertLocalEnvironment } from "../../../scripts/local-environment.mts";
import { migrateLocalSources } from "../scripts/migrate-local-storage";

test("local development rejects cloud endpoints and environment overrides", () => {
  for (const key of [
    "DATABASE_URL",
    "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
    "COMPILER_URL",
    "ENGINE_URL",
  ]) {
    expect(() =>
      assertLocalEnvironment({ [key]: "https://example.com" }),
    ).toThrow(key);
    expect(() => assertLocalEnvironment({ [key]: "not-a-url" })).toThrow(key);
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() =>
        assertLocalEnvironment({ [key]: `http://${host}:8080` }),
      ).not.toThrow();
    }
  }
  expect(() =>
    assertLocalEnvironment({ CLOUDFLARE_ENV: "production" }),
  ).toThrow("CLOUDFLARE_ENV");
  expect(() =>
    assertLocalEnvironment({
      CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: "production.jsonc",
    }),
  ).toThrow("CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH");
  expect(() => assertLocalEnvironment({})).not.toThrow();
  expect(() =>
    assertLocalEnvironment({
      DATABASE_URL: "postgres://localhost/db?host=example.com",
    }),
  ).toThrow("DATABASE_URL");
  expect(() =>
    assertLocalEnvironment({
      DATABASE_URL: "postgres://localhost/db?hostaddr=203.0.113.1",
    }),
  ).toThrow("DATABASE_URL");
});

test("default Worker storage writes stay in a disposable local emulator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "texfolia-local-resources-"));
  const platform = await getPlatformProxy<
    Pick<Cloudflare.Env, "SOURCES" | "HYPERDRIVE">
  >({
    configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    environment: "",
    envFiles: [],
    remoteBindings: false,
    persist: { path: directory },
  });
  try {
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(
      new URL(platform.env.HYPERDRIVE.connectionString).hostname,
    );
    await platform.env.SOURCES.put("local-isolation-check", "local content");
    expect(
      await (await platform.env.SOURCES.get("local-isolation-check"))?.text(),
    ).toBe("local content");
  } finally {
    await platform.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local bucket migration preserves files and metadata without overwriting or restoring later deletions", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "texfolia-local-source-upgrade-"),
  );
  const open = () =>
    new Miniflare({
      ...convertV4MiniflareOptions({
        modules: true,
        script: "export default { fetch() { return new Response(null); } }",
        r2Buckets: {
          PREVIOUS: "texfolia-sources",
          SOURCES: "texfolia-sources-local",
        },
      }),
      resourcePersistencePath: directory,
    });
  let runtime = open();
  try {
    const previous = await runtime.getR2Bucket("PREVIOUS");
    await previous.put("source.tex", "original source", {
      customMetadata: { hash: "source-hash" },
      httpMetadata: { contentType: "text/plain" },
    });
    await previous.put("edited.tex", "old edit");
    await (await runtime.getR2Bucket("SOURCES")).put("edited.tex", "new edit");
    await runtime.dispose();
    await migrateLocalSources(directory);
    runtime = open();
    const sources = await runtime.getR2Bucket("SOURCES");
    const copied = await sources.get("source.tex");
    expect(await copied?.text()).toBe("original source");
    expect(copied?.customMetadata).toEqual({ hash: "source-hash" });
    expect(copied?.httpMetadata?.contentType).toBe("text/plain");
    expect(await (await sources.get("edited.tex"))?.text()).toBe("new edit");
    expect(
      await (
        await (await runtime.getR2Bucket("PREVIOUS")).get("source.tex")
      )?.text(),
    ).toBe("original source");
    await sources.delete("source.tex");
    await runtime.dispose();
    await migrateLocalSources(directory);
    runtime = open();
    expect(
      await (await runtime.getR2Bucket("SOURCES")).get("source.tex"),
    ).toBeNull();
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("web configuration has local resources and one explicit production environment", async () => {
  const text = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const bindings = z.object({
    name: z.string(),
    r2_buckets: z.array(
      z.object({ bucket_name: z.string(), remote: z.boolean().optional() }),
    ),
    services: z.array(
      z.object({ service: z.string(), remote: z.boolean().optional() }),
    ),
    durable_objects: z.object({
      bindings: z.array(
        z.object({
          script_name: z.string().optional(),
          remote: z.boolean().optional(),
        }),
      ),
    }),
    hyperdrive: z.array(
      z.object({ id: z.string(), remote: z.boolean().optional() }),
    ),
  });
  const config = bindings
    .extend({ env: z.record(z.string(), bindings) })
    .parse(ts.parseConfigFileTextToJson("wrangler.jsonc", text).config);
  expect(Object.keys(config.env)).toEqual(["production"]);
  const production = config.env.production;
  expect(production).toBeDefined();
  expect(config.name).not.toBe(production?.name);
  for (const bucket of config.r2_buckets) {
    expect(bucket.remote).toBe(false);
    expect(
      production?.r2_buckets.some(
        (other) => other.bucket_name === bucket.bucket_name,
      ),
    ).toBe(false);
  }
  for (const service of config.services) {
    expect(service.remote).toBe(false);
    expect(
      production?.services.some((other) => other.service === service.service),
    ).toBe(false);
  }
  for (const binding of config.durable_objects.bindings) {
    expect(binding.script_name).toBeUndefined();
  }
  expect(config.hyperdrive[0]?.id).not.toBe(production?.hyperdrive[0]?.id);
  const compilerText = await readFile(
    new URL("../../compiler/wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const compilerConfig = z
    .object({
      name: z.string(),
      env: z.object({ production: z.object({ name: z.string() }) }),
    })
    .parse(ts.parseConfigFileTextToJson("wrangler.jsonc", compilerText).config);
  expect(config.services.map((service) => service.service)).toContain(
    compilerConfig.name,
  );
  expect(production?.services.map((service) => service.service)).toContain(
    compilerConfig.env.production.name,
  );
});
