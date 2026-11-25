import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectNode,
  session,
  subscription,
  user,
} from "@texfolia/db/schema";
import { inArray } from "drizzle-orm";
import { Miniflare } from "miniflare";
import { chromium, type Page } from "playwright";

import { withBuildsFixture } from "./builds/miniflare";

const connection = process.env.INTEGRATION_DATABASE_URL;
assert(
  connection && new URL(connection).pathname.includes("test"),
  "Use an isolated test database",
);
const db = createDb(connection);
const root = new URL("../dist/server/", import.meta.url).pathname;
const filenames = await readdir(root, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "texfolia-pricing-"));
const screenshots = new URL("../../../.audit/nat-283/", import.meta.url)
  .pathname;
await mkdir(screenshots, { recursive: true });
const secret = "pricing-ui-test-secret-at-least-32-characters";
const ownerId = crypto.randomUUID();
const memberId = crypto.randomUUID();
const orgId = crypto.randomUUID();
const organizations: string[] = [orgId];
const reservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = reservation.port;
await reservation.stop(true);
assert(port);
const origin = `http://127.0.0.1:${port}`;
const mf = new Miniflare({
  ...withBuildsFixture(
    {
      name: "pricing-ui-test",
      modules: filenames
        .filter((path) => path.endsWith(".js"))
        .sort((a, b) =>
          a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b),
        )
        .map((path) => ({ type: "ESModule", path: join(root, path) })),
      modulesRoot: root,
      compatibilityDate: "2026-10-31",
      compatibilityFlags: ["nodejs_compat"],
      assets: {
        directory: new URL("../dist/client/", import.meta.url).pathname,
        routerConfig: { has_user_worker: true },
      },
      durableObjects: {
        COLLABORATION: { className: "ProjectCollaboration", useSQLite: true },
      },
      r2Buckets: ["SOURCES"],
      hyperdrives: { HYPERDRIVE: connection },
      bindings: {
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: origin,
        STRIPE_SECRET_KEY: "sk_test_pricing_ui",
        STRIPE_PRO_PRICE_ID: "price_pro",
        STRIPE_TEAM_PRICE_ID: "price_team",
      },
    },
    async () => new Response(null, { status: 404 }),
  ),
  port,
  resourcePersistencePath: directory,
});
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    `${name} does not overflow`,
  );
  await page.screenshot({
    path: join(screenshots, `${name}.png`),
    fullPage: true,
  });
}
async function pageFor(userId?: string) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  if (userId) {
    const token = crypto.randomUUID();
    await db.insert(session).values({
      id: crypto.randomUUID(),
      token,
      userId,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const signature = createHmac("sha256", secret)
      .update(token)
      .digest("base64");
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: encodeURIComponent(`${token}.${signature}`),
        url: origin,
      },
    ]);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /content security policy/i.test(message.text())
    )
      errors.push(message.text());
  });
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.abort(),
  );
  return page;
}
try {
  await mf.ready;
  await db.insert(user).values(
    [ownerId, memberId].map((id) => ({
      id,
      name: "Billing reader",
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  await db.insert(organization).values({
    id: orgId,
    name: "Research group",
    slug: orgId,
    createdAt: new Date(),
  });
  await db.insert(member).values(
    [ownerId, memberId].map((id) => ({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: id,
      role: id === ownerId ? "owner" : "member",
      createdAt: new Date(),
    })),
  );
  // The account export keeps reading after the request's connection closed.
  const projectId = crypto.randomUUID();
  await db
    .insert(project)
    .values({ id: projectId, ownerId: memberId, name: "Exported" });
  const objectKey = `projects/${projectId}/sources/fixture`;
  await db.insert(projectNode).values({
    projectId,
    name: "main.tex",
    kind: "text",
    objectKey,
    sizeBytes: 15n,
  });
  const sources = await mf.getR2Bucket("SOURCES");
  await sources.put(objectKey, "exported source");
  const reader = await pageFor(memberId);
  await reader.goto(`${origin}/settings/account`);
  const link = reader.getByRole("link", { name: "Download my data" });
  assert.equal(await link.getAttribute("href"), "/api/account/export");
  const archive = await reader.request.get(`${origin}/api/account/export`);
  assert.equal(archive.status(), 200);
  assert.equal(archive.headers()["content-type"], "application/zip");
  const exported = await archive.text();
  for (const text of [
    "account.json",
    "projects/Exported/main.tex",
    "exported source",
  ])
    assert(exported.includes(text), text);
  assert(!exported.includes("missing-files.txt"));
  assert.equal((await fetch(`${origin}/api/account/export`)).status, 401);
  await reader.context().close();

  // Marketing /pricing lives on apps/web; this suite covers authenticated
  // billing on the product app (checkout bodies, portal, seats, authz).
  const owner = await pageFor(ownerId);
  await owner.goto(`${origin}/settings/billing?plan=pro`);
  const payloads: unknown[] = [];
  await owner.route("**/api/auth/subscription/upgrade", async (route) => {
    payloads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "Checkout fixture unavailable" }),
    });
  });
  await owner.getByRole("button", { name: "Continue to Pro checkout" }).click();
  await owner
    .getByRole("alert")
    .filter({ hasText: "Checkout fixture unavailable" })
    .waitFor();
  assert.deepEqual(payloads[0], {
    customerType: "user",
    plan: "pro",
    successUrl: "/settings/billing",
    cancelUrl: "/settings/billing?plan=pro",
    returnUrl: "/settings/billing",
  });
  await capture(owner, "billing-pro-error");
  await owner.goto(`${origin}/settings/billing?organizationId=${orgId}`);
  await owner.getByRole("heading", { name: "Research group · Team" }).waitFor();
  assert.match(
    await owner.locator("main").first().innerText(),
    /2 members × \$20 USD\/month = \$40 USD\/month/,
  );
  await owner
    .getByRole("button", { name: "Continue to Team checkout" })
    .click();
  await owner
    .getByRole("alert")
    .filter({ hasText: "Checkout fixture unavailable" })
    .waitFor();
  const teamReturn = `/settings/billing?organizationId=${orgId}`;
  assert.deepEqual(payloads[1], {
    customerType: "organization",
    referenceId: orgId,
    plan: "team",
    successUrl: teamReturn,
    cancelUrl: teamReturn,
    returnUrl: teamReturn,
  });
  await capture(owner, "billing-team-desktop");
  await owner.setViewportSize({ width: 320, height: 1000 });
  await capture(owner, "billing-team-mobile");
  await db.insert(subscription).values({
    id: crypto.randomUUID(),
    referenceId: orgId,
    plan: "team",
    status: "past_due",
    stripeCustomerId: "cus_fixture",
    stripeSubscriptionId: "sub_fixture",
    periodEnd: new Date(Date.now() - 1000),
  });
  await owner.goto(`${origin}/settings/billing?organizationId=${orgId}`);
  await owner
    .getByRole("button", { name: "Manage subscription and invoices" })
    .waitFor();
  assert.equal(
    await owner
      .getByRole("button", { name: "Continue to Team checkout" })
      .count(),
    0,
    "Past-due subscriptions recover through billing instead of duplicate checkout",
  );
  const portalRequests: unknown[] = [];
  await owner.route(
    "**/api/auth/subscription/billing-portal",
    async (route) => {
      portalRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          url: "https://billing.stripe.com/p/session/pricing-fixture",
          redirect: true,
        }),
      });
    },
  );
  await owner.route("https://billing.stripe.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<h1>Billing portal fixture</h1>",
    }),
  );
  await owner
    .getByRole("button", { name: "Manage subscription and invoices" })
    .click();
  await owner
    .getByRole("heading", { name: "Billing portal fixture" })
    .waitFor();
  assert.deepEqual(portalRequests[0], {
    customerType: "organization",
    referenceId: orgId,
    returnUrl: `${origin}/settings/billing?organizationId=${orgId}`,
  });
  const teammate = await pageFor(memberId);
  await teammate.goto(`${origin}/settings/billing?organizationId=${orgId}`);
  await teammate
    .getByText("Only an organization owner or admin can manage billing.")
    .waitFor();
  assert.equal(
    await teammate
      .getByRole("button", { name: /checkout|Manage subscription|Save cap/ })
      .count(),
    0,
  );
  await teammate
    .getByRole("link", { name: "See members", exact: true })
    .click();
  await teammate
    .getByRole("button", { name: "Leave organization", exact: true })
    .waitFor();
  assert.equal(
    await teammate
      .getByRole("button", {
        name: /^Remove|Send invitation|Rename|Delete organization/,
      })
      .count(),
    0,
    "Members cannot manage the organization",
  );
  await teammate.goto(`${origin}/settings/billing?organizationId=unrelated`);
  await teammate
    .getByRole("heading", { name: "Billing unavailable" })
    .waitFor();
  await owner.goto(`${origin}/settings/billing?plan=team`);
  await owner.getByLabel("Organization name").fill("New billing team");
  await owner
    .getByRole("button", { name: "Create organization", exact: true })
    .click();
  await owner
    .getByRole("heading", { name: "New billing team · Team" })
    .waitFor();
  const newId = new URL(owner.url()).searchParams.get("organizationId");
  assert(newId);
  organizations.push(newId);
  assert.match(
    await owner.locator("main").first().innerText(),
    /1 member × \$20 USD\/month = \$20 USD\/month/,
  );
  await owner.goto(`${origin}/settings/billing?organizationId=${orgId}`);
  await owner
    .getByRole("link", { name: "Manage members and roles", exact: true })
    .click();
  await owner
    .getByRole("button", { name: "Remove Billing reader", exact: true })
    .click();
  await owner
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove member", exact: true })
    .click();
  await owner
    .getByRole("status")
    .filter({ hasText: "Member removed" })
    .waitFor();
  await owner.goto(`${origin}/settings/billing?organizationId=${orgId}`);
  await owner.getByRole("heading", { name: "Research group · Team" }).waitFor();
  await owner
    .locator("main")
    .first()
    .filter({ hasText: /1 member × \$20 USD\/month = \$20 USD\/month/ })
    .waitFor();
  assert.deepEqual(errors, []);
  console.info(
    "Billing UI passed: Pro/Team checkout bodies, failure recovery, seat totals, portal, team creation, and authorization.",
  );
} finally {
  await browser.close();
  await mf.dispose();
  await db
    .delete(subscription)
    .where(inArray(subscription.referenceId, organizations));
  await db.delete(organization).where(inArray(organization.id, organizations));
  await db.delete(user).where(inArray(user.id, [ownerId, memberId]));
  await db.$client.end();
  await rm(directory, { recursive: true, force: true });
}
