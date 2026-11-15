import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { getPlatformProxy } from "wrangler";

import { createDb } from "../src/index";
import { seedTemplates } from "../src/seed-templates";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    local: { type: "boolean" },
    remote: { type: "boolean" },
    "persist-to": { type: "string" },
  },
});
if (
  !!values.local === !!values.remote ||
  (values.remote && values["persist-to"])
)
  throw new Error(
    "Use templates:seed --local [--persist-to directory] or --remote with DATABASE_URL and TEMPLATE_SEED_BUCKET.",
  );
const remote = !!values.remote;
const connectionString =
  process.env.DATABASE_URL ??
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString)
  throw new Error("Set DATABASE_URL to the target database.");
if (
  !remote &&
  !["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(connectionString).hostname,
  )
)
  throw new Error(
    "Local seeds require a local database. Use --remote for a deployed database and R2 bucket.",
  );
const bucketName = process.env.TEMPLATE_SEED_BUCKET;
if (remote && !bucketName)
  throw new Error("Set TEMPLATE_SEED_BUCKET to the target R2 bucket.");
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
  connectionString;
const db = createDb(connectionString);
const directory = await mkdtemp(join(tmpdir(), "texfolia-template-seeds-"));
const platform = remote
  ? null
  : await getPlatformProxy<{
      SOURCES: { put: Parameters<typeof seedTemplates>[0]["putSource"] };
    }>({
      configPath: fileURLToPath(
        new URL("../../../apps/web/wrangler.jsonc", import.meta.url),
      ),
      envFiles: [],
      remoteBindings: false,
      persist: {
        path:
          values["persist-to"] ??
          fileURLToPath(
            new URL("../../../apps/web/.wrangler/state/v3", import.meta.url),
          ),
      },
    });
try {
  const templates = await seedTemplates({
    db,
    putSource: async (key, bytes) => {
      if (platform) return platform.env.SOURCES.put(key, bytes);
      const path = join(directory, "source");
      await Bun.write(path, bytes);
      const child = Bun.spawn(
        [
          "bun",
          "x",
          "wrangler",
          "r2",
          "object",
          "put",
          `${bucketName}/${key}`,
          "--remote",
          "--file",
          path,
          "--content-type",
          "application/octet-stream",
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      if ((await child.exited) !== 0)
        throw new Error(`R2 upload failed for ${key}`);
    },
  });
  for (const item of templates)
    console.log(`${item.title}: /template/${item.id}`);
} finally {
  await db.$client.end();
  await platform?.dispose();
  await rm(directory, { recursive: true, force: true });
}
