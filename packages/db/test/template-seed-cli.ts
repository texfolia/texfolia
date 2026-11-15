import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { inArray, isNull } from "drizzle-orm";
import { getPlatformProxy } from "wrangler";

import { createDb } from "../src/index";
import { template } from "../src/schema";
import { starterLicense, templateStarters } from "../src/template-starters";

const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Set INTEGRATION_DATABASE_URL to an isolated Postgres test database",
);
const db = createDb(connectionString);
const directory = await mkdtemp(join(tmpdir(), "texfolia-seed-cli-"));
const seededIds: string[] = [];
try {
  assert.equal(
    (await db.select().from(template).where(isNull(template.ownerId))).length,
    0,
    "Run this check before seeding the test database",
  );
  for (const args of [
    ["--cwd", "packages/db", "templates:seed", "--local"],
    ["db:seed", "--"],
  ]) {
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
      ["bun", "run", ...args, "--persist-to", directory],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: { ...process.env, DATABASE_URL: connectionString },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const rows = await db
      .select()
      .from(template)
      .where(isNull(template.ownerId));
    seededIds.push(...rows.map((row) => row.id));
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
    assert.equal(rows.length, templateStarters.length);
    for (const row of rows) {
      assert(stdout.includes(`${row.title}: /template/${row.id}`));
      assert.equal(row.license, "CC0-1.0");
      assert.equal(row.status, "approved");
    }
  }
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
    connectionString;
  const platform = await getPlatformProxy<{
    SOURCES: {
      get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
    };
  }>({
    configPath: fileURLToPath(
      new URL("../../../apps/web/wrangler.jsonc", import.meta.url),
    ),
    envFiles: [],
    remoteBindings: false,
    persist: { path: directory },
  });
  try {
    const rows = await db
      .select()
      .from(template)
      .where(isNull(template.ownerId));
    for (const row of rows) {
      const starter = templateStarters.find((item) => item.title === row.title);
      assert(starter);
      for (const [name, content] of [
        ["main.tex", starter.source],
        ["LICENSE.txt", starterLicense],
      ]) {
        assert(Array.isArray(row.snapshot));
        const files: unknown[] = row.snapshot;
        const node = files.find(
          (item) =>
            item !== null &&
            typeof item === "object" &&
            "name" in item &&
            item.name === name,
        );
        assert(
          node !== null &&
            typeof node === "object" &&
            "objectKey" in node &&
            typeof node.objectKey === "string",
        );
        const object = await platform.env.SOURCES.get(node.objectKey);
        assert(object);
        assert.equal(await object.text(), content);
      }
    }
  } finally {
    await platform.dispose();
  }
  console.log(
    "Template seed CLI passed: package command, root command, rerun, and local R2 sources",
  );
} finally {
  if (seededIds.length)
    await db.delete(template).where(inArray(template.id, seededIds));
  await db.$client.end();
  await rm(directory, { recursive: true, force: true });
}
