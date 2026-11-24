import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

export async function runWorkerIntegration({
  name,
  entryPoint,
}: {
  name: string;
  entryPoint: URL;
}) {
  const connectionString = process.env.INTEGRATION_DATABASE_URL;
  assert(
    connectionString && new URL(connectionString).pathname.includes("test"),
    "Set INTEGRATION_DATABASE_URL to an isolated Postgres test database",
  );
  const bundled = await build({
    entryPoints: [fileURLToPath(entryPoint)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd"],
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire("file:///worker.js");',
    },
    external: [
      ...builtinModules,
      "node:*",
      "cloudflare:workers",
      "cloudflare:sockets",
      "#tanstack-router-entry",
      "#tanstack-start-entry",
      "tanstack-start-manifest:v",
    ],
    define: { "import.meta.env.DEV": "false" },
  });
  const script = bundled.outputFiles[0]?.text;
  assert(script);
  const directory = await mkdtemp(join(tmpdir(), `texfolia-${name}-`));
  const compilerRequests: { method: string; path: string }[] = [];
  const runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      name: `${name}-test`,
      modules: true,
      script,
      compatibilityDate: "2026-10-30",
      compatibilityFlags: ["nodejs_compat", "enable_nodejs_fs_module"],
      durableObjects: {
        COLLABORATION: { className: "ProjectCollaboration", useSQLite: true },
      },
      r2Buckets: ["SOURCES"],
      hyperdrives: { HYPERDRIVE: connectionString },
      serviceBindings: {
        COMPILER: (request: Request) => {
          const path = new URL(request.url).pathname;
          assert(
            (request.method === "POST" &&
              /^\/projects\/[^/]+\/changed$/.test(path)) ||
              (request.method === "DELETE" &&
                /^\/projects\/[^/]+\/build$/.test(path)),
            `Unexpected compiler request: ${request.method} ${path}`,
          );
          compilerRequests.push({ method: request.method, path });
          return new Response(null, { status: 204 });
        },
      },
    }),
    resourcePersistencePath: directory,
  });
  try {
    const response = await runtime.dispatchFetch((await runtime.ready).origin, {
      method: "POST",
    });
    const result = await response.text();
    assert.equal(response.status, 200, result);
    assert(
      compilerRequests.some((request) => request.method === "POST"),
      "Source changes must invalidate compiler state through the binding",
    );
    assert(
      compilerRequests.some((request) => request.method === "DELETE"),
      "Project deletion must clean compiler state through the binding",
    );
    console.log(result);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
