import type { Db } from "@texfolia/db";
import {
  aiMeterAttachment,
  aiOrganizationSettings,
  aiRequest,
  aiRun,
  aiSettings,
} from "@texfolia/db/schema";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type Stripe from "stripe";

import type { AiPayer } from "./entitlements";
import { getStripeClient } from "./stripe";
import { BillingError, markedUpNanos, nanoDollars } from "./usage";

/** The Stripe side of AI metering. The app's AI config satisfies it. */
export type MeteringConfig = {
  stripeKey: string;
  priceId: string;
  meterEventName: string;
};

/** The provider's cost for one request, in US dollars. */
export type UsageCost = {
  model: string;
  cost?: number | null;
  tokensIn?: number;
  tokensOut?: number;
};

/**
 * Looks up a request's cost by the provider log ID that the run recorded.
 * The app binds this to the AI Gateway logs API. A missing cost means "not
 * priced yet", never free.
 */
export type RequestCost = (request: {
  logId: string;
  accountId: string;
  gatewayId: string;
}) => Promise<UsageCost>;

// A webhook drops an attachment as soon as Stripe changes the subscription, so
// this only bounds how long a missed webhook goes unnoticed.
const attachmentMs = 24 * 60 * 60_000;

/**
 * Makes sure the payer's subscription carries the AI usage price. Asks Stripe
 * only when that is not already known.
 */
export async function ensureAiSubscription({
  db,
  config,
  payer,
  stripe,
}: {
  db: Db;
  config: MeteringConfig;
  payer: AiPayer;
  stripe?: Pick<
    Stripe,
    "prices" | "subscriptions" | "subscriptionItems" | "billing"
  >;
}) {
  const attachment = {
    stripeCustomerId: payer.customerId,
    priceId: config.priceId,
    meterEventName: config.meterEventName,
  };
  const [known] = await db
    .select({ checkedAt: aiMeterAttachment.checkedAt })
    .from(aiMeterAttachment)
    .where(
      and(
        eq(aiMeterAttachment.stripeSubscriptionId, payer.subscriptionId),
        eq(aiMeterAttachment.stripeCustomerId, attachment.stripeCustomerId),
        eq(aiMeterAttachment.priceId, attachment.priceId),
        eq(aiMeterAttachment.meterEventName, attachment.meterEventName),
        gt(aiMeterAttachment.checkedAt, new Date(Date.now() - attachmentMs)),
      ),
    );
  if (known) return;
  const client = stripe ?? getStripeClient(config.stripeKey);
  // Recorded as of now: a change during the checks is newer than this.
  const checkedAt = new Date();
  const [price, subscription] = await Promise.all([
    client.prices.retrieve(config.priceId),
    client.subscriptions.retrieve(payer.subscriptionId),
  ]);
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  if (
    customerId !== payer.customerId ||
    !["active", "trialing"].includes(subscription.status)
  )
    throw new BillingError(
      "Your subscription changed. Refresh before using AI.",
      409,
    );
  if (
    price.currency !== "usd" ||
    Number(price.unit_amount_decimal) !== 0.0000001 ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "metered" ||
    !price.recurring.meter
  )
    throw new BillingError(
      "AI billing is not configured correctly. Try again later.",
      503,
    );
  const meter = await client.billing.meters.retrieve(price.recurring.meter);
  if (
    meter.event_name !== config.meterEventName ||
    meter.default_aggregation.formula !== "sum" ||
    meter.status !== "active" ||
    meter.customer_mapping.event_payload_key !== "stripe_customer_id" ||
    meter.customer_mapping.type !== "by_id" ||
    meter.value_settings.event_payload_key !== "value" ||
    meter.event_time_window != null
  )
    throw new BillingError("AI usage meter is not configured correctly.", 503);
  if (!subscription.items.data.some((item) => item.price.id === price.id))
    await client.subscriptionItems.create(
      {
        subscription: subscription.id,
        price: price.id,
        proration_behavior: "none",
      },
      { idempotencyKey: `ai-item-${subscription.id}-${price.id}` },
    );
  await db
    .insert(aiMeterAttachment)
    .values({
      stripeSubscriptionId: payer.subscriptionId,
      ...attachment,
      checkedAt,
    })
    .onConflictDoUpdate({
      target: aiMeterAttachment.stripeSubscriptionId,
      set: { ...attachment, checkedAt },
    });
}

/** Has the next AI run check the subscription with Stripe again. */
export async function forgetAiSubscription(db: Db, subscriptionId: string) {
  await db
    .delete(aiMeterAttachment)
    .where(eq(aiMeterAttachment.stripeSubscriptionId, subscriptionId));
}

export async function getAiSettings(db: Db, userId: string) {
  await db.insert(aiSettings).values({ userId }).onConflictDoNothing();
  const [settings] = await db
    .select()
    .from(aiSettings)
    .where(eq(aiSettings.userId, userId));
  if (!settings) throw new Error("AI settings not found");
  return settings;
}

/** An organization's shared AI spend cap, created with its default on first use. */
export async function getOrganizationAiSettings(
  db: Db,
  organizationId: string,
) {
  await db
    .insert(aiOrganizationSettings)
    .values({ organizationId })
    .onConflictDoNothing();
  const [settings] = await db
    .select()
    .from(aiOrganizationSettings)
    .where(eq(aiOrganizationSettings.organizationId, organizationId));
  if (!settings) throw new Error("Organization AI settings not found");
  return settings;
}

const thisMonth = sql`${aiRequest.createdAt} >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`;

/** This month's AI spend billed to one Stripe customer, across every user. */
export async function payerAiSpend(db: Db, customerIds: string[]) {
  if (!customerIds.length) return { spent: 0, reserved: 0 };
  const [row] = await db
    .select({
      spent: sql<string>`coalesce(sum(${aiRequest.chargedNanos}), 0)`,
      reserved: sql<string>`coalesce(sum(case when ${aiRequest.chargedNanos} is null then ${aiRequest.reservedNanos} else 0 end), 0)`,
    })
    .from(aiRequest)
    .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
    .where(and(inArray(aiRun.stripeCustomerId, customerIds), thisMonth));
  return {
    spent: Number(row?.spent ?? 0),
    reserved: Number(row?.reserved ?? 0),
  };
}

export async function aiSpend(db: Db, userId: string) {
  const [row] = await db
    .select({
      spent: sql<string>`coalesce(sum(${aiRequest.chargedNanos}), 0)`,
      reserved: sql<string>`coalesce(sum(case when ${aiRequest.chargedNanos} is null then ${aiRequest.reservedNanos} else 0 end), 0)`,
      review: sql<boolean>`coalesce(bool_or(${aiRequest.status} = 'needs_review'), false)`,
      pending: sql<number>`count(*) filter (where ${aiRequest.status} in ('pending', 'priced'))::int`,
    })
    .from(aiRequest)
    .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
    .where(
      and(
        eq(aiRun.userId, userId),
        // A call crossing midnight belongs to the month it started, rather than the run's month.
        sql`${aiRequest.createdAt} >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`,
      ),
    );
  return {
    spent: Number(row?.spent ?? 0),
    reserved: Number(row?.reserved ?? 0),
    needsReview: row?.review ?? false,
    pendingRequests: row?.pending ?? 0,
  };
}

export async function reserveAiRequest({
  db,
  runId,
  userId,
  payer,
  model,
  reservedNanos,
}: {
  db: Db;
  runId: string;
  userId: string;
  payer: AiPayer;
  model: string;
  reservedNanos: number;
}) {
  if (payer.organizationId)
    await getOrganizationAiSettings(db, payer.organizationId);
  return db.transaction(async (tx) => {
    // Always lock the user's row before the organization's, so concurrent
    // reservations cannot deadlock.
    const [settings] = await tx
      .select()
      .from(aiSettings)
      .where(eq(aiSettings.userId, userId))
      .for("update");
    if (!settings) throw new Error("AI settings not found");
    const [usage] = await tx
      .select({
        total: sql<string>`coalesce(sum(coalesce(${aiRequest.chargedNanos}, ${aiRequest.reservedNanos})), 0)`,
      })
      .from(aiRequest)
      .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
      .where(and(eq(aiRun.userId, userId), thisMonth));
    if (Number(usage?.total ?? 0) + reservedNanos > settings.monthlyCapNanos)
      throw new BillingError(
        "Your monthly AI spend cap has been reached, or there is not enough remaining for this request. Adjust the cap or choose a less expensive model.",
        402,
      );
    if (payer.organizationId) {
      // The organization's cap bounds every member's usage billed to it.
      const [organizationSettings] = await tx
        .select()
        .from(aiOrganizationSettings)
        .where(eq(aiOrganizationSettings.organizationId, payer.organizationId))
        .for("update");
      if (!organizationSettings)
        throw new Error("Organization AI settings not found");
      const [payerUsage] = await tx
        .select({
          total: sql<string>`coalesce(sum(coalesce(${aiRequest.chargedNanos}, ${aiRequest.reservedNanos})), 0)`,
        })
        .from(aiRequest)
        .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
        .where(and(eq(aiRun.stripeCustomerId, payer.customerId), thisMonth));
      if (
        Number(payerUsage?.total ?? 0) + reservedNanos >
        organizationSettings.monthlyCapNanos
      )
        throw new BillingError(
          "Your organization's monthly AI spend cap has been reached. Ask an organization owner or admin to raise it.",
          402,
        );
    }
    const [run] = await tx
      .select({ stripeCustomerId: aiRun.stripeCustomerId })
      .from(aiRun)
      .where(and(eq(aiRun.id, runId), eq(aiRun.userId, userId)));
    if (run?.stripeCustomerId !== payer.customerId)
      throw new BillingError("Your access changed. Refresh the project.", 409);
    const [request] = await tx
      .insert(aiRequest)
      .values({ runId, model, reservedNanos })
      .returning();
    if (!request) throw new Error("Could not reserve AI usage");
    return request;
  });
}

export type MeterReporter = (event: {
  identifier: string;
  event_name: string;
  timestamp: number;
  payload: { stripe_customer_id: string; value: string };
}) => Promise<unknown>;

class MeteringReviewRequired extends Error {}

export async function reconcileAiUsage({
  db,
  config,
  requestCost,
  runId,
  userId,
  report,
}: {
  db: Db;
  config: MeteringConfig;
  requestCost: RequestCost;
  runId?: string;
  userId?: string;
  report?: MeterReporter;
}) {
  const send: MeterReporter =
    report ??
    ((event) =>
      getStripeClient(config.stripeKey).billing.meterEvents.create(event, {
        idempotencyKey: event.identifier,
      }));
  // A dead Worker may never reach its terminal hook. Its durable requests still settle.
  await db
    .update(aiRun)
    .set({ status: "aborted", finishedAt: new Date() })
    .where(
      and(
        eq(aiRun.status, "running"),
        sql`${aiRun.createdAt} < now() - interval '10 minutes'`,
      ),
    );
  const rows = await db
    .select({ request: aiRequest, run: aiRun })
    .from(aiRequest)
    .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
    .where(
      and(
        inArray(aiRequest.status, ["pending", "priced"]),
        sql`${aiRun.status} <> 'running'`,
        lte(aiRequest.nextAttemptAt, sql`now()`),
        runId ? eq(aiRun.id, runId) : undefined,
        userId ? eq(aiRun.userId, userId) : undefined,
      ),
    )
    .orderBy(aiRequest.nextAttemptAt)
    .limit(50);
  let retryAfterSeconds: number | null = rows.length === 50 ? 0 : null;
  for (const row of rows) {
    // Claim a short lease; never hold a database transaction across provider calls.
    const current = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(aiRequest)
        .where(
          and(
            eq(aiRequest.id, row.request.id),
            inArray(aiRequest.status, ["pending", "priced"]),
            lte(aiRequest.nextAttemptAt, sql`now()`),
          ),
        )
        .for("update");
      if (!current) return null;
      await tx
        .update(aiRequest)
        .set({ nextAttemptAt: sql`now() + interval '2 minutes'` })
        .where(eq(aiRequest.id, current.id));
      return current;
    });
    if (!current) continue;
    const attempts = current.attempts + 1;
    try {
      let charged = current.chargedNanos;
      if (charged === null) {
        if (!current.logId)
          throw new Error(
            "Gateway response did not provide a log ID; reconcile by request metadata",
          );
        const log = await requestCost({
          logId: current.logId,
          accountId: row.run.accountId,
          gatewayId: row.run.gatewayId,
        });
        if (log.cost == null) throw new Error("Gateway log has no cost yet");
        const base = Math.ceil(log.cost * nanoDollars);
        charged = markedUpNanos(base, row.run.markupPercent);
        await db
          .update(aiRequest)
          .set({
            status: "priced",
            model: log.model,
            baseCostNanos: base,
            chargedNanos: charged,
            inputTokens: log.tokensIn,
            outputTokens: log.tokensOut,
          })
          .where(eq(aiRequest.id, current.id));
      }
      // Zero is an actual cost; missing cost is never treated as free.
      if (charged > 0) {
        // Stripe deduplicates identifiers and idempotency keys for a limited window.
        if (
          current.reportStartedAt &&
          Date.now() - current.reportStartedAt.getTime() > 23 * 3600_000
        )
          throw new MeteringReviewRequired(
            "Uncertain Stripe delivery is older than 23 hours; verify Stripe before replaying",
          );
        await db
          .update(aiRequest)
          .set({ reportStartedAt: current.reportStartedAt ?? new Date() })
          .where(eq(aiRequest.id, current.id));
        await send({
          identifier: `texfolia-ai-${current.id}`,
          event_name: row.run.meterEventName,
          timestamp: Math.floor(current.createdAt.getTime() / 1000),
          payload: {
            stripe_customer_id: row.run.stripeCustomerId,
            value: String(charged),
          },
        });
      }
      await db
        .update(aiRequest)
        .set({
          status: "reported",
          reportedAt: new Date(),
          error: null,
          attempts,
        })
        .where(eq(aiRequest.id, current.id));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "AI metering failed";
      const needsReview =
        attempts >= 12 || error instanceof MeteringReviewRequired;
      const delaySeconds = Math.min(3600, 30 * 2 ** attempts);
      await db
        .update(aiRequest)
        .set({
          attempts,
          error: message,
          ...(needsReview ? { status: "needs_review" } : {}),
          nextAttemptAt: sql`now() + ${delaySeconds} * interval '1 second'`,
        })
        .where(eq(aiRequest.id, current.id));
      if (!needsReview)
        retryAfterSeconds =
          retryAfterSeconds === null
            ? delaySeconds
            : Math.min(retryAfterSeconds, delaySeconds);
      console.error({
        event: "ai_metering_retry",
        requestId: current.id,
        runId: row.run.id,
        attempts,
        needsReview,
        error: message,
      });
    }
  }
  return { retryAfterSeconds };
}
