import type { Db } from "@texfolia/db";
import { aiRequest, aiRun, aiSettings } from "@texfolia/db/schema";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import Stripe from "stripe";

import {
  cloudflareJson,
  gatewayLogSchema,
  type AiConfig,
  type AiFetch,
} from "./gateway.server";
import { AiError, markedUpNanos, nanoDollars } from "./schema";

export async function aiEntitlement(
  db: Db,
  userId: string,
  organizationId?: string | null,
) {
  const memberships = await db.query.member.findMany({
    columns: { organizationId: true },
    where: { userId },
  });
  const subscriptions = await db.query.subscription.findMany({
    where: {
      referenceId: {
        in: [userId, ...memberships.map((m) => m.organizationId)],
      },
      plan: { in: ["pro", "team"] },
      status: { in: ["active", "trialing"] },
    },
  });
  const eligible = subscriptions.filter(
    (s) =>
      s.stripeCustomerId &&
      s.stripeSubscriptionId &&
      (!s.periodEnd || s.periodEnd > new Date()),
  );
  const subscription =
    eligible.find((s) => s.referenceId === organizationId) ??
    eligible.find((s) => s.referenceId === userId) ??
    eligible[0];
  if (!subscription?.stripeCustomerId || !subscription.stripeSubscriptionId)
    throw new AiError(
      "The assistant requires Pro or Team. Upgrade to use AI.",
      403,
    );
  return {
    customerId: subscription.stripeCustomerId,
    subscriptionId: subscription.stripeSubscriptionId,
  };
}

export function createAiStripe(config: AiConfig) {
  return new Stripe(config.stripeKey, {
    apiVersion: "2026-10-28.endive",
    maxNetworkRetries: 0,
    timeout: 15_000,
  });
}

export async function ensureAiSubscription(
  config: AiConfig,
  payer: Awaited<ReturnType<typeof aiEntitlement>>,
) {
  const stripe = createAiStripe(config);
  const [price, subscription] = await Promise.all([
    stripe.prices.retrieve(config.priceId),
    stripe.subscriptions.retrieve(payer.subscriptionId),
  ]);
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  if (
    customerId !== payer.customerId ||
    !["active", "trialing"].includes(subscription.status)
  )
    throw new AiError(
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
    throw new AiError(
      "AI billing is not configured correctly. Try again later.",
      503,
    );
  const meter = await stripe.billing.meters.retrieve(price.recurring.meter);
  if (
    meter.event_name !== config.meterEventName ||
    meter.default_aggregation.formula !== "sum" ||
    meter.status !== "active" ||
    meter.customer_mapping.event_payload_key !== "stripe_customer_id" ||
    meter.customer_mapping.type !== "by_id" ||
    meter.value_settings.event_payload_key !== "value" ||
    meter.event_time_window != null
  )
    throw new AiError("AI usage meter is not configured correctly.", 503);
  if (!subscription.items.data.some((item) => item.price.id === price.id))
    await stripe.subscriptionItems.create(
      {
        subscription: subscription.id,
        price: price.id,
        proration_behavior: "none",
      },
      { idempotencyKey: `ai-item-${subscription.id}-${price.id}` },
    );
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
  model,
  reservedNanos,
}: {
  db: Db;
  runId: string;
  userId: string;
  model: string;
  reservedNanos: number;
}) {
  return db.transaction(async (tx) => {
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
      .where(
        and(
          eq(aiRun.userId, userId),
          sql`${aiRequest.createdAt} >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`,
        ),
      );
    if (Number(usage?.total ?? 0) + reservedNanos > settings.monthlyCapNanos)
      throw new AiError(
        "Your monthly AI spend cap has been reached, or there is not enough remaining for this request. Adjust the cap or choose a less expensive model.",
        402,
      );
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
  runId,
  userId,
  fetcher = fetch,
  report,
}: {
  db: Db;
  config: AiConfig;
  runId?: string;
  userId?: string;
  fetcher?: AiFetch;
  report?: MeterReporter;
}) {
  const stripe = report ? null : createAiStripe(config);
  const send: MeterReporter =
    report ??
    ((event) => {
      if (!stripe) throw new Error("Stripe unavailable");
      return stripe.billing.meterEvents.create(event, {
        idempotencyKey: event.identifier,
      });
    });
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
        const log = gatewayLogSchema.parse(
          await cloudflareJson(
            { accountId: row.run.accountId, apiToken: config.apiToken },
            `ai-gateway/gateways/${encodeURIComponent(row.run.gatewayId)}/logs/${encodeURIComponent(current.logId)}`,
            fetcher,
          ),
        ).result;
        if (log.id !== current.logId)
          throw new Error("Gateway returned a different log ID");
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
            inputTokens: log.tokens_in,
            outputTokens: log.tokens_out,
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
      await db
        .update(aiRequest)
        .set({
          attempts,
          error: message,
          ...(needsReview ? { status: "needs_review" } : {}),
          nextAttemptAt: sql`now() + ${Math.min(3600, 30 * 2 ** attempts)} * interval '1 second'`,
        })
        .where(eq(aiRequest.id, current.id));
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
}
