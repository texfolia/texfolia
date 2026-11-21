import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localHosts } from "@texfolia/auth/hosts";
import { unknownEngineTiming } from "@texfolia/contracts";
import { createDb } from "@texfolia/db";
import { session, template, user } from "@texfolia/db/schema";
import { seedTemplates } from "@texfolia/db/seed-templates";
import { eq, inArray } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { chromium } from "playwright";

import { createLocalRuntime } from "../../compiler/src/local";
import { HttpError } from "../../compiler/src/project";

const connectionString = process.env.INTEGRATION_DATABASE_URL;
assert(
  connectionString && new URL(connectionString).pathname.includes("test"),
  "Use an isolated Postgres test database",
);
const db = createDb(connectionString);
const directory = await mkdtemp(join(tmpdir(), "texfolia-template-lifecycle-"));
const root = new URL("../dist/server/", import.meta.url).pathname;
const filenames = await readdir(root, { recursive: true });
const reviewer = crypto.randomUUID();
const secret = "template-lifecycle-test-secret-not-for-production";
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=",
    "base64",
  ),
);
let failOnce = true;
let runs = 0;
const engine = async () => {
  runs++;
  if (failOnce) {
    failOnce = false;
    throw new HttpError(422, "Fixture TeX failure");
  }
  return {
    pdf: new TextEncoder().encode("%PDF-fixture"),
    preview: png,
    log: "Compiled",
    timing: unknownEngineTiming,
  };
};
const compiler = createLocalRuntime({
  path: join(directory, "compiler.sqlite"),
  projectEngine: () => engine,
});
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    name: "template-lifecycle-test",
    modules: filenames
      .filter((path) => path.endsWith(".js"))
      .sort((a, b) =>
        a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b),
      )
      .map((path) => ({ type: "ESModule", path: join(root, path) })),
    modulesRoot: root,
    compatibilityDate: "2025-09-02",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      directory: new URL("../dist/client/", import.meta.url).pathname,
      routerConfig: { has_user_worker: true },
    },
    durableObjects: {
      COLLABORATION: { className: "ProjectCollaboration", useSQLite: true },
    },
    r2Buckets: ["SOURCES"],
    hyperdrives: { HYPERDRIVE: connectionString },
    bindings: {
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: "http://localhost",
      STRIPE_SECRET_KEY: "sk_test_templates",
      TEMPLATE_REVIEWER_IDS: reviewer,
      ...Object.fromEntries(
        ["GITHUB", "GOOGLE", "GITLAB", "MICROSOFT"].flatMap((provider) => [
          [`${provider}_CLIENT_ID`, "fixture"],
          [`${provider}_CLIENT_SECRET`, "fixture"],
        ]),
      ),
    },
    serviceBindings: {
      COMPILER: async (request) => {
        const response = await compiler.fetch(
          new Request(request.url, {
            method: request.method,
            headers: [...request.headers.entries()],
            body: request.method === "POST" ? await request.text() : undefined,
          }),
        );
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers: response.headers,
        });
      },
    },
  }),
  resourcePersistencePath: directory,
});
const browser = await chromium.launch({ headless: true });
let ids: string[] = [];
try {
  const origin = (await mf.ready).origin;
  const bucket = await mf.getR2Bucket("SOURCES");
  const seeds = await seedTemplates({
    db,
    putSource: (key, bytes) => bucket.put(key, bytes),
  });
  ids = seeds.map((item) => item.id);
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      console.error("Browser error", message.text());
  });
  // Marketing /templates is on apps/web. Preview generation still runs from
  // app template detail pages via useTemplatePreviews.
  for (const seed of seeds) {
    await page.goto(`${origin}/template/${seed.id}`);
  }
  await page
    .getByRole("heading", { name: "Simple article", exact: true })
    .waitFor();
  const webOrigin = (
    process.env.TEMPLATE_TEST_WEB_URL ??
    process.env.PUBLIC_WEB_URL ??
    localHosts.web[0]
  ).replace(/\/$/, "");
  try {
    const probe = await fetch(new URL("/templates", webOrigin), {
      signal: AbortSignal.timeout(2000),
    });
    if (probe.ok) {
      await page.goto(`${webOrigin}/templates`);
      await page
        .getByRole("heading", { name: "Simple article", exact: true })
        .waitFor();
    }
  } catch {
    console.info(
      `Skipped apps/web gallery browse (unreachable at ${webOrigin}/templates)`,
    );
  }
  const deadline = Date.now() + 75_000;
  let failed: typeof template.$inferSelect | undefined;
  while (true) {
    const rows = await db
      .select()
      .from(template)
      .where(inArray(template.id, ids));
    failed = rows.find((row) => row.previewStatus === "failed");
    if (
      failed &&
      rows.filter((row) => row.previewStatus === "ready").length === 2
    )
      break;
    assert(
      Date.now() < deadline,
      `Gallery must finish previews without scheduled events: ${JSON.stringify(rows.map((row) => ({ id: row.id, previewStatus: row.previewStatus, next: row.previewNextAttemptAt })))}. Browser errors: ${errors.join("; ")}`,
    );
    await Bun.sleep(50);
  }
  await page.goto(`${origin}/template/${failed.id}`);
  assert.equal(
    await page.getByRole("button", { name: "Retry preview" }).count(),
    0,
    "Anonymous viewers cannot retry",
  );
  assert.equal(
    (
      await page.request.get(`${origin}/api/templates/${failed.id}/source`)
    ).status(),
    200,
  );
  await db.insert(user).values({
    id: reviewer,
    name: "Reviewer",
    email: `${reviewer}@example.com`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const token = crypto.randomUUID();
  await db.insert(session).values({
    id: crypto.randomUUID(),
    token,
    userId: reviewer,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await context.addCookies([
    {
      name: "better-auth.session_token",
      url: origin,
      value: encodeURIComponent(
        `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`,
      ),
    },
  ]);
  await db
    .update(template)
    .set({ previewStartedAt: new Date(Date.now() - 61_000) })
    .where(eq(template.id, failed.id));
  await page.reload();
  await page.getByRole("button", { name: "Retry preview" }).click();
  const image = page.getByRole("img", {
    name: `First page of ${failed.title}`,
  });
  await image.waitFor();
  assert(
    await image.evaluate(
      (image) =>
        image instanceof HTMLImageElement &&
        image.complete &&
        image.naturalWidth > 0,
    ),
  );
  const [retried] = await db
    .select()
    .from(template)
    .where(eq(template.id, failed.id));
  assert(
    retried &&
      retried.previewJobId !== failed.previewJobId &&
      retried.status === "approved",
  );
  assert.deepEqual(retried.snapshot, failed.snapshot);
  assert.equal(runs, 4, "Three seed previews plus one explicit retry");
  assert.equal(errors.length, 0, errors.join("\n"));
  const ssr = Bun.spawn(
    ["bun", "run", new URL("./template-pages.ts", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        TEMPLATE_TEST_BASE_URL: origin,
        TEMPLATE_TEST_WEB_URL: webOrigin,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  assert.equal(
    await ssr.exited,
    0,
    "Server-rendered template pages and protected assets",
  );
  console.info(
    "Template browser lifecycle passed: original seeds, automatic gallery previews without cron, failed-preview source access, anonymous permissions, reviewer retry, persisted PNG, and unchanged snapshot and moderation.",
  );
} finally {
  await browser.close();
  await mf.dispose();
  await compiler.close();
  if (ids.length) await db.delete(template).where(inArray(template.id, ids));
  await db.delete(user).where(eq(user.id, reviewer));
  await db.$client.end();
  await rm(directory, { recursive: true, force: true });
}
