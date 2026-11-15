import assert from "node:assert/strict";

import { createDb } from "@texfolia/db";
import {
  aiRequest,
  aiRun,
  aiSettings,
  member,
  organization,
  subscription,
  user,
} from "@texfolia/db/schema";
import { eq, inArray } from "drizzle-orm";

import {
  aiEntitlement,
  aiSpend,
  getAiSettings,
  reconcileAiUsage,
  reserveAiRequest,
  type MeterReporter,
} from "../src/lib/ai/billing.server";
import type { AiConfig, AiFetch } from "../src/lib/ai/gateway.server";
import { AiError, markedUpNanos, nanoDollars } from "../src/lib/ai/schema";

const connection = process.env.INTEGRATION_DATABASE_URL;
assert(
  connection && new URL(connection).pathname.includes("test"),
  "Use an isolated test database",
);
const db = createDb(connection);
const userId = crypto.randomUUID();
const freeId = crypto.randomUUID();
const teamId = crypto.randomUUID();
const orgId = crypto.randomUUID();
const runIds: string[] = [];
const subscriptionIds: string[] = [];
const config: AiConfig = {
  accountId: "a".repeat(32),
  gatewayId: "test",
  apiToken: "test-only",
  stripeKey: "sk_test_fixture",
  priceId: "price_ai",
  meterEventName: "ai_nanos",
};
const events: Parameters<MeterReporter>[0][] = [];
let logCalls = 0;
let missingCost = false;
const fetcher: AiFetch = async (input) => {
  logCalls++;
  const logId = new URL(String(input)).pathname.split("/").at(-1);
  return Response.json({
    success: true,
    result: {
      id: logId,
      model: "@cf/test/model",
      tokens_in: 100,
      tokens_out: 50,
      ...(missingCost ? {} : { cost: 0.01 }),
    },
  });
};
const report: MeterReporter = async (event) => {
  events.push(event);
};
async function run(
  status: "running" | "succeeded" | "failed" | "aborted" = "succeeded",
) {
  const id = crypto.randomUUID();
  runIds.push(id);
  await db.insert(aiRun).values({
    id,
    userId,
    clientRunId: id,
    projectId: crypto.randomUUID(),
    model: "@cf/test/model",
    stripeCustomerId: "cus_pro",
    stripeSubscriptionId: "sub_pro",
    accountId: config.accountId,
    gatewayId: config.gatewayId,
    meterEventName: config.meterEventName,
    status,
    finishedAt: status === "running" ? null : new Date(),
  });
  return id;
}
async function request(
  runId: string,
  options: Partial<typeof aiRequest.$inferInsert> = {},
) {
  const [row] = await db
    .insert(aiRequest)
    .values({
      runId,
      model: "@cf/test/model",
      logId: crypto.randomUUID(),
      reservedNanos: nanoDollars,
      ...options,
    })
    .returning();
  assert(row);
  return row;
}
async function retry(id: string) {
  await db
    .update(aiRequest)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(aiRequest.id, id));
}
async function row(id: string) {
  const [found] = await db.select().from(aiRequest).where(eq(aiRequest.id, id));
  assert(found);
  return found;
}
try {
  await db.insert(user).values(
    [userId, freeId, teamId].map((id) => ({
      id,
      name: "AI billing fixture",
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  await assert.rejects(
    aiEntitlement(db, freeId),
    (e) => e instanceof AiError && e.status === 403,
  );
  const subId = crypto.randomUUID();
  subscriptionIds.push(subId);
  await db.insert(subscription).values({
    id: subId,
    referenceId: userId,
    plan: "pro",
    status: "active",
    stripeCustomerId: "cus_pro",
    stripeSubscriptionId: "sub_pro",
  });
  assert.deepEqual(await aiEntitlement(db, userId), {
    customerId: "cus_pro",
    subscriptionId: "sub_pro",
  });
  await db
    .insert(organization)
    .values({ id: orgId, name: "AI team", slug: orgId, createdAt: new Date() });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: teamId,
    role: "member",
    createdAt: new Date(),
  });
  const teamSub = crypto.randomUUID();
  subscriptionIds.push(teamSub);
  await db.insert(subscription).values({
    id: teamSub,
    referenceId: orgId,
    plan: "pro",
    status: "active",
    stripeCustomerId: "cus_team",
    stripeSubscriptionId: "sub_team",
  });
  assert.equal((await aiEntitlement(db, teamId)).customerId, "cus_team");
  await db.delete(member).where(eq(member.userId, teamId));
  await assert.rejects(aiEntitlement(db, teamId));
  assert.equal(
    (await getAiSettings(db, userId)).monthlyCapNanos,
    20 * nanoDollars,
  );
  assert.equal(markedUpNanos(10_000_000), 12_000_000);
  for (const outcome of ["succeeded", "failed", "aborted"] as const) {
    const id = await run(outcome);
    const first = await request(id);
    const second = await request(id);
    const before = events.length;
    await reconcileAiUsage({ db, config, runId: id, fetcher, report });
    assert.equal(
      events.length,
      before + 2,
      `${outcome} usage is billed after the run`,
    );
    for (const saved of [await row(first.id), await row(second.id)]) {
      assert.equal(saved.status, "reported");
      assert.equal(saved.baseCostNanos, 10_000_000);
      assert.equal(saved.chargedNanos, 12_000_000);
      assert.equal(saved.inputTokens, 100);
    }
    assert.equal(events.at(-1)?.payload.value, "12000000");
    assert.equal(events.at(-1)?.payload.stripe_customer_id, "cus_pro");
    await reconcileAiUsage({ db, config, runId: id, fetcher, report });
    assert.equal(
      events.length,
      before + 2,
      "already reported requests are not reported again",
    );
  }
  const active = await run("running");
  const activeRequest = await request(active);
  await reconcileAiUsage({ db, config, runId: active, fetcher, report });
  assert.equal(
    (await row(activeRequest.id)).attempts,
    0,
    "running usage waits for run completion",
  );
  await db
    .update(aiRun)
    .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
    .where(eq(aiRun.id, active));
  await reconcileAiUsage({ db, config, runId: active, fetcher, report });
  assert.equal(
    (await row(activeRequest.id)).status,
    "reported",
    "crashed workers are reconciled",
  );

  const failed = await run("failed");
  const failedRequest = await request(failed);
  const attempts: string[] = [];
  const brokenReport: MeterReporter = async (event) => {
    attempts.push(event.identifier);
    if (attempts.length === 1) throw new Error("Stripe response lost");
  };
  await reconcileAiUsage({
    db,
    config,
    runId: failed,
    fetcher,
    report: brokenReport,
  });
  assert.equal((await row(failedRequest.id)).status, "priced");
  assert.equal((await row(failedRequest.id)).chargedNanos, 12_000_000);
  const callsBeforeRetry = logCalls;
  await retry(failedRequest.id);
  await reconcileAiUsage({
    db,
    config,
    runId: failed,
    fetcher,
    report: brokenReport,
  });
  assert.equal(
    logCalls,
    callsBeforeRetry,
    "Stripe retry uses the persisted price",
  );
  assert.equal(
    attempts[0],
    attempts[1],
    "Stripe retry preserves event identifier",
  );
  assert.equal((await row(failedRequest.id)).status, "reported");

  const missing = await run("aborted");
  const missingRequest = await request(missing);
  missingCost = true;
  const eventsBefore = events.length;
  await reconcileAiUsage({ db, config, runId: missing, fetcher, report });
  assert.equal((await row(missingRequest.id)).chargedNanos, null);
  assert.equal(
    events.length,
    eventsBefore,
    "missing costs are never guessed or sent to Stripe",
  );
  missingCost = false;
  await retry(missingRequest.id);
  await reconcileAiUsage({ db, config, runId: missing, fetcher, report });
  assert.equal(
    (await row(missingRequest.id)).status,
    "reported",
    "delayed log eventually bills",
  );
  const unpriced = await run("failed");
  const unpricedRequest = await request(unpriced, { attempts: 11 });
  missingCost = true;
  await reconcileAiUsage({ db, config, runId: unpriced, fetcher, report });
  assert.equal((await row(unpricedRequest.id)).status, "needs_review");
  assert.equal((await row(unpricedRequest.id)).chargedNanos, null);
  const lost = await run("aborted");
  const lostRequest = await request(lost, { logId: null, attempts: 11 });
  await reconcileAiUsage({ db, config, runId: lost, fetcher, report });
  assert.equal((await row(lostRequest.id)).status, "needs_review");
  assert(
    (await aiSpend(db, userId)).reserved >= 2 * nanoDollars,
    "unresolved provider calls retain their reservation",
  );

  const parallelRun = await run();
  const parallel = await request(parallelRun);
  missingCost = false;
  const eventCount = events.length;
  await Promise.all([
    reconcileAiUsage({ db, config, runId: parallelRun, fetcher, report }),
    reconcileAiUsage({ db, config, runId: parallelRun, fetcher, report }),
  ]);
  assert.equal(
    events.length,
    eventCount + 1,
    "concurrent reconcilers claim one lease",
  );
  assert.equal((await row(parallel.id)).status, "reported");
  const uncertainRun = await run("failed");
  const uncertain = await request(uncertainRun, {
    status: "priced",
    chargedNanos: 12_000_000,
    baseCostNanos: 10_000_000,
    reportStartedAt: new Date(Date.now() - 25 * 3600_000),
  });
  const beforeUncertain = events.length;
  await reconcileAiUsage({ db, config, runId: uncertainRun, fetcher, report });
  assert.equal((await row(uncertain.id)).status, "needs_review");
  assert.equal(
    events.length,
    beforeUncertain,
    "an uncertain delivery beyond Stripe's deduplication window is never replayed automatically",
  );
  const zeroRun = await run();
  const zero = await request(zeroRun);
  const zeroFetcher: AiFetch = async () =>
    Response.json({
      success: true,
      result: {
        id: zero.logId,
        model: zero.model,
        cost: 0,
        tokens_in: 0,
        tokens_out: 0,
      },
    });
  await reconcileAiUsage({
    db,
    config,
    runId: zeroRun,
    fetcher: zeroFetcher,
    report,
  });
  assert.equal((await row(zero.id)).status, "reported");
  assert.equal((await row(zero.id)).chargedNanos, 0);
  assert.equal(
    events.length,
    beforeUncertain,
    "genuine zero-cost usage is recorded without a Stripe event",
  );
  const budget = await run("running");
  await db
    .update(aiSettings)
    .set({
      monthlyCapNanos:
        (await aiSpend(db, userId)).spent +
        (await aiSpend(db, userId)).reserved +
        10 * nanoDollars,
    })
    .where(eq(aiSettings.userId, userId));
  const reservations = await Promise.allSettled(
    [1, 2].map(() =>
      reserveAiRequest({
        db,
        runId: budget,
        userId,
        model: "@cf/test/model",
        reservedNanos: 6 * nanoDollars,
      }),
    ),
  );
  assert.equal(
    reservations.filter((r) => r.status === "fulfilled").length,
    1,
    "concurrent calls cannot overspend the remaining cap",
  );
  assert.equal(reservations.filter((r) => r.status === "rejected").length, 1);
  console.info(
    "AI billing passed: Pro/Team access, Free denial, successful/failed/aborted runs, log delays, Stripe retries, missing cost review, crash recovery, concurrent leases and spend caps.",
  );
} finally {
  if (runIds.length) {
    await db.delete(aiRequest).where(inArray(aiRequest.runId, runIds));
    await db.delete(aiRun).where(inArray(aiRun.id, runIds));
  }
  if (subscriptionIds.length)
    await db
      .delete(subscription)
      .where(inArray(subscription.id, subscriptionIds));
  await db.delete(organization).where(eq(organization.id, orgId));
  await db.delete(user).where(inArray(user.id, [userId, freeId, teamId]));
  await db.$client.end();
}
