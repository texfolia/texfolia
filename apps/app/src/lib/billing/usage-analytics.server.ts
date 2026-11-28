import { paidPlans } from "@texfolia/contracts/plans";
import type { Db } from "@texfolia/db";
import {
  aiRequest,
  aiRun,
  member,
  organizationAuditEvent,
  project,
  projectJob,
  projectNode,
  user,
} from "@texfolia/db/schema";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type Stripe from "stripe";

import { isOrgAdmin } from "#/lib/auth/roles";
import { accessibleProjects } from "#/lib/projects/project.server";

import { getAiSettings, getOrganizationAiSettings } from "./metering";
import { getStripeClient } from "./stripe";
import { BillingError, nanoDollars } from "./usage";
import {
  buildDailyAiSeries,
  buildDailyCompileSeries,
  buildSeatHistorySeries,
  computeCapUtilizationPercent,
  resolveUsagePeriod,
  roundDollars,
  roundMinutes,
  utcDayKey,
  type EstimatedInvoice,
  type InvoiceRecord,
  type SeatChangeEvent,
  type StripeMeterSummary,
  type UsageDashboard,
  type UsagePeriod,
} from "./usage-analytics";

export type UsageStripeClient = Pick<Stripe, "invoices" | "prices" | "billing">;

function extractInvoiceTaxCents(invoice: Stripe.Invoice): number {
  const totalTaxes = (
    invoice as Stripe.Invoice & {
      total_taxes?: { amount: number }[] | null;
      tax?: number | null;
    }
  ).total_taxes;
  if (Array.isArray(totalTaxes) && totalTaxes.length > 0) {
    return totalTaxes.reduce((sum, item) => sum + (item.amount ?? 0), 0);
  }
  const legacyTax = (invoice as Stripe.Invoice & { tax?: number | null }).tax;
  if (typeof legacyTax === "number") return legacyTax;
  return Math.max(0, (invoice.total ?? 0) - (invoice.subtotal ?? 0));
}

export async function fetchStripeInvoices(
  stripeClient: Pick<Stripe, "invoices"> | null,
  customerId: string | null,
): Promise<{
  status: "ok" | "unavailable";
  items: InvoiceRecord[];
  note?: string;
}> {
  if (!customerId) {
    return {
      status: "unavailable",
      items: [],
      note: "No Stripe billing customer is linked to this account yet.",
    };
  }
  if (!stripeClient) {
    return {
      status: "unavailable",
      items: [],
      note: "Stripe invoice history is unavailable in this environment.",
    };
  }
  try {
    const response = await stripeClient.invoices.list({
      customer: customerId,
      limit: 12,
    });
    const items: InvoiceRecord[] = response.data.map((inv) => {
      const taxCents = extractInvoiceTaxCents(inv);
      return {
        id: inv.id,
        number: inv.number ?? null,
        createdAt: new Date(inv.created * 1000).toISOString(),
        status: inv.status ?? null,
        subtotalDollars: roundDollars((inv.subtotal ?? 0) / 100),
        taxDollars: roundDollars(taxCents / 100),
        totalDollars: roundDollars((inv.total ?? 0) / 100),
        currency: (inv.currency ?? "usd").toUpperCase(),
        hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
        invoicePdf: inv.invoice_pdf ?? null,
      };
    });
    return { status: "ok", items };
  } catch {
    return {
      status: "unavailable",
      items: [],
      note: "Could not load invoices from Stripe right now. Open the Stripe Customer Portal from Billing to view invoices.",
    };
  }
}

export async function fetchStripeMeterSummary({
  stripeClient,
  customerId,
  aiPriceId,
  start,
  end,
}: {
  stripeClient: Pick<Stripe, "prices" | "billing"> | null;
  customerId: string | null;
  aiPriceId: string | undefined;
  start: Date;
  end: Date;
}): Promise<StripeMeterSummary> {
  if (!stripeClient || !customerId || !aiPriceId) {
    return {
      status: "unavailable",
      totalDollars: null,
      daily: [],
      note: "Stripe meter reconciliation is unavailable in this environment.",
    };
  }
  try {
    const price = await stripeClient.prices.retrieve(aiPriceId);
    const meterId = price.recurring?.meter;
    if (!meterId) {
      return {
        status: "unavailable",
        totalDollars: null,
        daily: [],
        note: "AI meter is not attached to the configured Stripe price.",
      };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    // Stripe requires start_time/end_time on day boundaries for value_grouping_window="day".
    const startSec = Math.floor(start.getTime() / 1000);
    const endBoundarySec = Math.min(
      Math.floor(end.getTime() / 1000),
      Math.ceil(nowSec / 86400) * 86400,
    );
    if (endBoundarySec <= startSec) {
      return { status: "ok", totalDollars: 0, daily: [] };
    }
    const summaries = await stripeClient.billing.meters.listEventSummaries(
      meterId,
      {
        customer: customerId,
        start_time: startSec,
        end_time: endBoundarySec,
        value_grouping_window: "day",
        limit: 100,
      },
    );
    let totalNanos = 0;
    const daily = summaries.data.map((entry) => {
      const value = Number(entry.aggregated_value ?? 0);
      totalNanos += value;
      return {
        date: utcDayKey(new Date(entry.start_time * 1000)),
        dollars: roundDollars(value / nanoDollars),
      };
    });
    return {
      status: "ok",
      totalDollars: roundDollars(totalNanos / nanoDollars),
      daily,
    };
  } catch {
    return {
      status: "unavailable",
      totalDollars: null,
      daily: [],
      note: "Stripe meter summaries are temporarily unavailable; showing local metered records.",
    };
  }
}

const unavailableEstimatedInvoice = (
  hasStripeCustomer: boolean,
): EstimatedInvoice => ({
  status: "unavailable",
  subtotalDollars: null,
  taxDollars: null,
  totalDollars: null,
  currency: "USD",
  periodStart: null,
  periodEnd: null,
  lines: [],
  note: hasStripeCustomer
    ? "Current-period estimated invoice preview (including tax) is managed via Billing and the Stripe Customer Portal."
    : "Upgrade to Pro or Team in Billing to see estimated and historical invoices.",
});

export async function getUsageDashboard(
  db: Db,
  {
    userId,
    organizationId,
    period = "current_month",
    now = new Date(),
    stripe,
    aiPriceId = process.env.STRIPE_AI_PRICE_ID,
    estimatedInvoice,
  }: {
    userId: string;
    organizationId?: string;
    period?: UsagePeriod;
    now?: Date;
    stripe?: UsageStripeClient | null;
    aiPriceId?: string;
    /** Optional current-period preview supplied by NAT-489 once implemented. */
    estimatedInvoice?: EstimatedInvoice | null;
  },
): Promise<UsageDashboard> {
  const resolved = resolveUsagePeriod(period, now);
  const memberships = await db.query.member.findMany({
    where: { userId },
    with: {
      organization: {
        columns: { id: true, name: true, stripeCustomerId: true },
      },
    },
  });

  const adminOrganizations = memberships.flatMap((m) =>
    m.organization && isOrgAdmin(m.role)
      ? [{ id: m.organization.id, name: m.organization.name }]
      : [],
  );

  let selectedOrg: {
    id: string;
    name: string;
    stripeCustomerId: string | null;
  } | null = null;

  if (organizationId) {
    const membership = memberships.find(
      (m) => m.organizationId === organizationId,
    );
    if (!membership || !membership.organization) {
      throw new BillingError("Organization not found", 404);
    }
    if (!isOrgAdmin(membership.role)) {
      throw new BillingError(
        "Only an organization owner or admin can view organization usage and billing.",
        403,
      );
    }
    selectedOrg = membership.organization;
  }

  const scope = selectedOrg ? "organization" : "personal";
  const referenceId = selectedOrg ? selectedOrg.id : userId;

  const [subscriptions, userRow] = await Promise.all([
    db.query.subscription.findMany({
      where: {
        referenceId,
        stripeSubscriptionId: { isNotNull: true },
        status: {
          in: [
            "active",
            "trialing",
            "past_due",
            "unpaid",
            "incomplete",
            "paused",
          ],
        },
      },
      orderBy: { periodEnd: "desc" },
    }),
    selectedOrg
      ? Promise.resolve(null)
      : db.query.user.findFirst({
          columns: { id: true, stripeCustomerId: true },
          where: { id: userId },
        }),
  ]);

  const activeSubscription = subscriptions[0] ?? null;
  const customerIds = [
    ...new Set([
      ...(selectedOrg?.stripeCustomerId ? [selectedOrg.stripeCustomerId] : []),
      ...(userRow?.stripeCustomerId ? [userRow.stripeCustomerId] : []),
      ...subscriptions.flatMap((s) => s.stripeCustomerId ?? []),
    ]),
  ];
  const primaryCustomerId = customerIds[0] ?? null;

  // Scope filter for AI queries:
  // - personal: all runs initiated by this user
  // - organization: all runs billed to the organization's Stripe customer(s)
  const aiScopeCondition = selectedOrg
    ? customerIds.length
      ? inArray(aiRun.stripeCustomerId, customerIds)
      : sql`false`
    : eq(aiRun.userId, userId);

  const aiDateCondition = and(
    gte(aiRequest.createdAt, resolved.start),
    lt(aiRequest.createdAt, resolved.end),
  );

  // Accessible projects for compiles & storage
  const projectsList = selectedOrg
    ? await db
        .select({ id: project.id, name: project.name })
        .from(project)
        .where(
          and(
            eq(project.organizationId, selectedOrg.id),
            isNull(project.deletedAt),
          ),
        )
    : await db.query.project.findMany({
        columns: { id: true, name: true },
        where: accessibleProjects(userId),
      });

  const projectIds = projectsList.map((p) => p.id);
  const projectNameById = new Map(projectsList.map((p) => [p.id, p.name]));

  const stripeClient: UsageStripeClient | null =
    stripe !== undefined
      ? stripe
      : process.env.STRIPE_SECRET_KEY
        ? getStripeClient(process.env.STRIPE_SECRET_KEY)
        : null;

  const [
    capSettings,
    aiTotalsRows,
    aiDailyRows,
    aiModelRows,
    aiProjectRows,
    aiMemberRows,
    compileDailyRows,
    compileProjectRows,
    storageProjectRows,
    orgMembers,
    orgAuditEvents,
    invoicesResult,
    stripeMeterSummary,
  ] = await Promise.all([
    selectedOrg
      ? getOrganizationAiSettings(db, selectedOrg.id)
      : getAiSettings(db, userId),
    db
      .select({
        chargedNanos: sql<string>`coalesce(sum(${aiRequest.chargedNanos}), 0)`,
        reservedNanos: sql<string>`coalesce(sum(case when ${aiRequest.chargedNanos} is null then ${aiRequest.reservedNanos} else 0 end), 0)`,
        inputTokens: sql<number>`coalesce(sum(coalesce(${aiRequest.inputTokens}, 0)), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(coalesce(${aiRequest.outputTokens}, 0)), 0)::int`,
        pendingRequests: sql<number>`count(*) filter (where ${aiRequest.status} in ('pending', 'priced'))::int`,
        needsReview: sql<boolean>`coalesce(bool_or(${aiRequest.status} = 'needs_review'), false)`,
      })
      .from(aiRequest)
      .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
      .where(and(aiScopeCondition, aiDateCondition)),
    db
      .select({
        day: sql<string>`to_char(${aiRequest.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        chargedNanos: sql<string>`coalesce(sum(${aiRequest.chargedNanos}), 0)`,
        reservedNanos: sql<string>`coalesce(sum(case when ${aiRequest.chargedNanos} is null then ${aiRequest.reservedNanos} else 0 end), 0)`,
        inputTokens: sql<number>`coalesce(sum(coalesce(${aiRequest.inputTokens}, 0)), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(coalesce(${aiRequest.outputTokens}, 0)), 0)::int`,
        requests: sql<number>`count(*)::int`,
      })
      .from(aiRequest)
      .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
      .where(and(aiScopeCondition, aiDateCondition))
      .groupBy(
        sql`to_char(${aiRequest.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      )
      .orderBy(
        sql`to_char(${aiRequest.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      ),
    db
      .select({
        model: aiRequest.model,
        chargedNanos: sql<string>`coalesce(sum(${aiRequest.chargedNanos}), 0)`,
        reservedNanos: sql<string>`coalesce(sum(case when ${aiRequest.chargedNanos} is null then ${aiRequest.reservedNanos} else 0 end), 0)`,
        inputTokens: sql<number>`coalesce(sum(coalesce(${aiRequest.inputTokens}, 0)), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(coalesce(${aiRequest.outputTokens}, 0)), 0)::int`,
        requests: sql<number>`count(*)::int`,
      })
      .from(aiRequest)
      .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
      .where(and(aiScopeCondition, aiDateCondition))
      .groupBy(aiRequest.model)
      .orderBy(
        desc(
          sql`coalesce(sum(coalesce(${aiRequest.chargedNanos}, ${aiRequest.reservedNanos})), 0)`,
        ),
      ),
    db
      .select({
        projectId: aiRun.projectId,
        projectName: project.name,
        chargedNanos: sql<string>`coalesce(sum(${aiRequest.chargedNanos}), 0)`,
        reservedNanos: sql<string>`coalesce(sum(case when ${aiRequest.chargedNanos} is null then ${aiRequest.reservedNanos} else 0 end), 0)`,
        inputTokens: sql<number>`coalesce(sum(coalesce(${aiRequest.inputTokens}, 0)), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(coalesce(${aiRequest.outputTokens}, 0)), 0)::int`,
        requests: sql<number>`count(*)::int`,
      })
      .from(aiRequest)
      .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
      .leftJoin(project, eq(project.id, aiRun.projectId))
      .where(and(aiScopeCondition, aiDateCondition))
      .groupBy(aiRun.projectId, project.name)
      .orderBy(
        desc(
          sql`coalesce(sum(coalesce(${aiRequest.chargedNanos}, ${aiRequest.reservedNanos})), 0)`,
        ),
      ),
    selectedOrg
      ? db
          .select({
            userId: aiRun.userId,
            name: user.name,
            email: user.email,
            chargedNanos: sql<string>`coalesce(sum(${aiRequest.chargedNanos}), 0)`,
            reservedNanos: sql<string>`coalesce(sum(case when ${aiRequest.chargedNanos} is null then ${aiRequest.reservedNanos} else 0 end), 0)`,
            inputTokens: sql<number>`coalesce(sum(coalesce(${aiRequest.inputTokens}, 0)), 0)::int`,
            outputTokens: sql<number>`coalesce(sum(coalesce(${aiRequest.outputTokens}, 0)), 0)::int`,
            requests: sql<number>`count(*)::int`,
          })
          .from(aiRequest)
          .innerJoin(aiRun, eq(aiRun.id, aiRequest.runId))
          .leftJoin(user, eq(user.id, aiRun.userId))
          .where(and(aiScopeCondition, aiDateCondition))
          .groupBy(aiRun.userId, user.name, user.email)
          .orderBy(
            desc(
              sql`coalesce(sum(coalesce(${aiRequest.chargedNanos}, ${aiRequest.reservedNanos})), 0)`,
            ),
          )
      : Promise.resolve([]),
    projectIds.length
      ? db
          .select({
            day: sql<string>`to_char(${projectJob.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
            total: sql<number>`count(*)::int`,
            succeeded: sql<number>`count(*) filter (where ${projectJob.status} = 'succeeded')::int`,
            failed: sql<number>`count(*) filter (where ${projectJob.status} = 'failed')::int`,
            durationMs: sql<string>`coalesce(sum(coalesce(${projectJob.durationMs}::double precision, (${projectJob.timing}->'compiler'->>'compileMs')::double precision, greatest(0, extract(epoch from (${projectJob.finishedAt} - ${projectJob.startedAt})) * 1000), 0)), 0)`,
          })
          .from(projectJob)
          .where(
            and(
              inArray(projectJob.projectId, projectIds),
              gte(projectJob.createdAt, resolved.start),
              lt(projectJob.createdAt, resolved.end),
            ),
          )
          .groupBy(
            sql`to_char(${projectJob.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          )
          .orderBy(
            sql`to_char(${projectJob.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
          )
      : Promise.resolve([]),
    projectIds.length
      ? db
          .select({
            projectId: projectJob.projectId,
            total: sql<number>`count(*)::int`,
            succeeded: sql<number>`count(*) filter (where ${projectJob.status} = 'succeeded')::int`,
            failed: sql<number>`count(*) filter (where ${projectJob.status} = 'failed')::int`,
            durationMs: sql<string>`coalesce(sum(coalesce(${projectJob.durationMs}::double precision, (${projectJob.timing}->'compiler'->>'compileMs')::double precision, greatest(0, extract(epoch from (${projectJob.finishedAt} - ${projectJob.startedAt})) * 1000), 0)), 0)`,
          })
          .from(projectJob)
          .where(
            and(
              inArray(projectJob.projectId, projectIds),
              gte(projectJob.createdAt, resolved.start),
              lt(projectJob.createdAt, resolved.end),
            ),
          )
          .groupBy(projectJob.projectId)
          .orderBy(desc(sql`count(*)`))
      : Promise.resolve([]),
    projectIds.length
      ? db
          .select({
            projectId: projectNode.projectId,
            bytes: sql<string>`coalesce(sum(${projectNode.sizeBytes}), 0)`,
          })
          .from(projectNode)
          .where(
            and(
              inArray(projectNode.projectId, projectIds),
              isNull(projectNode.deletedAt),
            ),
          )
          .groupBy(projectNode.projectId)
          .orderBy(desc(sql`coalesce(sum(${projectNode.sizeBytes}), 0)`))
      : Promise.resolve([]),
    selectedOrg
      ? db
          .select({ createdAt: member.createdAt })
          .from(member)
          .where(eq(member.organizationId, selectedOrg.id))
          .orderBy(asc(member.createdAt))
      : Promise.resolve([]),
    selectedOrg
      ? db
          .select({
            action: organizationAuditEvent.action,
            metadata: organizationAuditEvent.metadata,
            createdAt: organizationAuditEvent.createdAt,
          })
          .from(organizationAuditEvent)
          .where(
            and(
              eq(organizationAuditEvent.organizationId, selectedOrg.id),
              inArray(organizationAuditEvent.action, [
                "billing.subscription_started",
                "billing.seats_updated",
                "billing.subscription_canceled",
              ]),
            ),
          )
          .orderBy(asc(organizationAuditEvent.createdAt))
      : Promise.resolve([]),
    fetchStripeInvoices(stripeClient, primaryCustomerId),
    fetchStripeMeterSummary({
      stripeClient,
      customerId: primaryCustomerId,
      aiPriceId,
      start: resolved.start,
      end: resolved.end,
    }),
  ]);

  const aiTotals = aiTotalsRows[0];
  const monthlyCapDollars = roundDollars(
    capSettings.monthlyCapNanos / nanoDollars,
  );
  const spentDollars = roundDollars(
    Number(aiTotals?.chargedNanos ?? 0) / nanoDollars,
  );
  const reservedDollars = roundDollars(
    Number(aiTotals?.reservedNanos ?? 0) / nanoDollars,
  );
  const totalProjectedDollars = roundDollars(spentDollars + reservedDollars);

  const dailyAi = buildDailyAiSeries(
    resolved.days,
    aiDailyRows.map((row) => ({
      day: row.day,
      chargedNanos: Number(row.chargedNanos),
      reservedNanos: Number(row.reservedNanos),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      requests: row.requests,
    })),
  );

  const dailyCompiles = buildDailyCompileSeries(
    resolved.days,
    compileDailyRows.map((row) => ({
      day: row.day,
      succeeded: row.succeeded,
      failed: row.failed,
      total: row.total,
      durationMs: Number(row.durationMs),
    })),
  );

  const compileTotals = compileDailyRows.reduce(
    (acc, row) => ({
      total: acc.total + row.total,
      succeeded: acc.succeeded + row.succeeded,
      failed: acc.failed + row.failed,
      durationMs: acc.durationMs + Number(row.durationMs),
    }),
    { total: 0, succeeded: 0, failed: 0, durationMs: 0 },
  );

  let totalStorageBytes = 0n;
  const storageByProject = storageProjectRows.map((row) => {
    const bytes = BigInt(row.bytes);
    totalStorageBytes += bytes;
    return {
      projectId: row.projectId,
      projectName: projectNameById.get(row.projectId) ?? "Untitled project",
      sourceBytes: row.bytes,
    };
  });

  let seatsSection: UsageDashboard["seats"] = null;
  if (selectedOrg) {
    const memberCount = orgMembers.length;
    const currentSeats = activeSubscription?.seats ?? memberCount;
    const auditSeatEvents: SeatChangeEvent[] = [];
    for (const ev of orgAuditEvents) {
      if (ev.action === "billing.subscription_canceled") {
        auditSeatEvents.push({
          createdAt: ev.createdAt,
          seats: 0,
          source: "audit",
        });
      } else if (typeof ev.metadata?.seats === "number") {
        auditSeatEvents.push({
          createdAt: ev.createdAt,
          seats: ev.metadata.seats,
          source: "audit",
        });
      }
    }
    const events: SeatChangeEvent[] =
      auditSeatEvents.length > 0
        ? auditSeatEvents
        : orgMembers.map((m, index) => ({
            createdAt: m.createdAt,
            seats: index + 1,
            source: "membership" as const,
          }));
    seatsSection = {
      currentSeats,
      memberCount,
      monthlyRateUsd: paidPlans.team.monthlyUsd,
      history: buildSeatHistorySeries({
        days: resolved.days,
        events,
        currentSeats,
        todayKey: utcDayKey(now),
      }),
    };
  }

  return {
    scope,
    payerLabel: selectedOrg ? selectedOrg.name : "Personal",
    organization: selectedOrg
      ? { id: selectedOrg.id, name: selectedOrg.name }
      : null,
    organizations: adminOrganizations,
    period: {
      id: resolved.id,
      label: resolved.label,
      startIso: resolved.start.toISOString(),
      endIso: resolved.end.toISOString(),
      isCalendarMonth: resolved.isCalendarMonth,
    },
    ai: {
      monthlyCapDollars,
      spentDollars,
      reservedDollars,
      totalProjectedDollars,
      capUtilizationPercent: computeCapUtilizationPercent(
        totalProjectedDollars,
        monthlyCapDollars,
      ),
      pendingRequests: aiTotals?.pendingRequests ?? 0,
      needsReview: aiTotals?.needsReview ?? false,
      totalInputTokens: aiTotals?.inputTokens ?? 0,
      totalOutputTokens: aiTotals?.outputTokens ?? 0,
      daily: dailyAi,
      byModel: aiModelRows.map((row) => ({
        model: row.model,
        chargedDollars: roundDollars(Number(row.chargedNanos) / nanoDollars),
        reservedDollars: roundDollars(Number(row.reservedNanos) / nanoDollars),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        requests: row.requests,
      })),
      byProject: aiProjectRows.map((row) => ({
        projectId: row.projectId,
        projectName: row.projectName ?? "Deleted project",
        chargedDollars: roundDollars(Number(row.chargedNanos) / nanoDollars),
        reservedDollars: roundDollars(Number(row.reservedNanos) / nanoDollars),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        requests: row.requests,
      })),
      byMember: aiMemberRows.map((row) => ({
        userId: row.userId,
        name: row.name ?? "Deleted user",
        email: row.email ?? "",
        chargedDollars: roundDollars(Number(row.chargedNanos) / nanoDollars),
        reservedDollars: roundDollars(Number(row.reservedNanos) / nanoDollars),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        requests: row.requests,
      })),
      stripeMeterSummary,
    },
    compiles: {
      total: compileTotals.total,
      succeeded: compileTotals.succeeded,
      failed: compileTotals.failed,
      totalMinutes: roundMinutes(compileTotals.durationMs),
      daily: dailyCompiles,
      byProject: compileProjectRows.map((row) => ({
        projectId: row.projectId,
        projectName: projectNameById.get(row.projectId) ?? "Untitled project",
        total: row.total,
        succeeded: row.succeeded,
        failed: row.failed,
        minutes: roundMinutes(Number(row.durationMs)),
      })),
    },
    storage: {
      sourceBytes: totalStorageBytes.toString(),
      projectCount: projectIds.length,
      byProject: storageByProject,
    },
    seats: seatsSection,
    billing: {
      hasStripeCustomer: primaryCustomerId !== null,
      subscriptionStatus: activeSubscription?.status ?? null,
      plan: activeSubscription?.plan ?? null,
      periodEnd: activeSubscription?.periodEnd
        ? activeSubscription.periodEnd.toISOString()
        : null,
      cancelAtPeriodEnd: Boolean(activeSubscription?.cancelAtPeriodEnd),
      estimatedInvoice:
        estimatedInvoice ??
        unavailableEstimatedInvoice(primaryCustomerId !== null),
      invoices: invoicesResult,
    },
  };
}
