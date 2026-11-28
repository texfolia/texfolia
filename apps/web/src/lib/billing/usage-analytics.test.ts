import { describe, expect, test } from "bun:test";

import type Stripe from "stripe";

import { BillingError, nanoDollars } from "./usage";
import {
  buildDailyAiSeries,
  buildDailyCompileSeries,
  buildSeatHistorySeries,
  computeCapUtilizationPercent,
  escapeCsvCell,
  formatUsageCsv,
  resolveUsagePeriod,
  type UsageDashboard,
} from "./usage-analytics";
import {
  fetchStripeInvoices,
  fetchStripeMeterSummary,
  getUsageDashboard,
} from "./usage-analytics.server";

describe("resolveUsagePeriod", () => {
  const fixedNow = new Date("2026-11-15T14:30:00.000Z");

  test("resolves current_month in UTC up through today", () => {
    const resolved = resolveUsagePeriod("current_month", fixedNow);
    expect(resolved.start.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(resolved.end.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(resolved.isCalendarMonth).toBe(true);
    expect(resolved.days[0]).toBe("2026-11-01");
    expect(resolved.days.at(-1)).toBe("2026-11-15");
    expect(resolved.days).toHaveLength(15);
  });

  test("resolves previous_month across all days of that UTC month", () => {
    const resolved = resolveUsagePeriod("previous_month", fixedNow);
    expect(resolved.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(resolved.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(resolved.isCalendarMonth).toBe(true);
    expect(resolved.days[0]).toBe("2026-10-01");
    expect(resolved.days.at(-1)).toBe("2026-10-31");
    expect(resolved.days).toHaveLength(31);
  });

  test("resolves rolling 30-day and 90-day windows", () => {
    const last30 = resolveUsagePeriod("last_30_days", fixedNow);
    expect(last30.isCalendarMonth).toBe(false);
    expect(last30.days).toHaveLength(30);
    expect(last30.days.at(-1)).toBe("2026-11-15");

    const last90 = resolveUsagePeriod("last_90_days", fixedNow);
    expect(last90.isCalendarMonth).toBe(false);
    expect(last90.days).toHaveLength(90);
    expect(last90.days.at(-1)).toBe("2026-11-15");
  });
});

describe("series aggregation", () => {
  test("fills empty days with zeros and tracks charged vs reserved cumulative spend", () => {
    const days = ["2026-11-01", "2026-11-02", "2026-11-03"];
    const series = buildDailyAiSeries(days, [
      {
        day: "2026-11-01",
        chargedNanos: 1_500_000_000,
        reservedNanos: 250_000_000,
        inputTokens: 1000,
        outputTokens: 500,
        requests: 2,
      },
      {
        day: "2026-11-03",
        chargedNanos: 500_000_000,
        reservedNanos: 0,
        inputTokens: 400,
        outputTokens: 200,
        requests: 1,
      },
    ]);

    expect(series).toEqual([
      {
        date: "2026-11-01",
        chargedDollars: 1.5,
        reservedDollars: 0.25,
        cumulativeDollars: 1.75,
        inputTokens: 1000,
        outputTokens: 500,
        requests: 2,
      },
      {
        date: "2026-11-02",
        chargedDollars: 0,
        reservedDollars: 0,
        cumulativeDollars: 1.75,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
      },
      {
        date: "2026-11-03",
        chargedDollars: 0.5,
        reservedDollars: 0,
        cumulativeDollars: 2.25,
        inputTokens: 400,
        outputTokens: 200,
        requests: 1,
      },
    ]);
  });

  test("handles completely empty periods cleanly", () => {
    const days = ["2026-11-01", "2026-11-02"];
    const aiSeries = buildDailyAiSeries(days, []);
    expect(aiSeries.every((p) => p.cumulativeDollars === 0)).toBe(true);

    const compileSeries = buildDailyCompileSeries(days, []);
    expect(compileSeries).toEqual([
      { date: "2026-11-01", succeeded: 0, failed: 0, total: 0, minutes: 0 },
      { date: "2026-11-02", succeeded: 0, failed: 0, total: 0, minutes: 0 },
    ]);
  });

  test("converts compile milliseconds to rounded minutes", () => {
    const series = buildDailyCompileSeries(
      ["2026-11-01"],
      [
        {
          day: "2026-11-01",
          succeeded: 3,
          failed: 1,
          total: 4,
          durationMs: 90_000,
        },
      ],
    );
    expect(series[0]).toEqual({
      date: "2026-11-01",
      succeeded: 3,
      failed: 1,
      total: 4,
      minutes: 1.5,
    });
  });

  test("computes cap utilization including $0 cap edge cases", () => {
    expect(computeCapUtilizationPercent(0, 0)).toBe(0);
    expect(computeCapUtilizationPercent(0.5, 0)).toBe(100);
    expect(computeCapUtilizationPercent(16, 20)).toBe(80);
    expect(computeCapUtilizationPercent(25, 20)).toBe(125);
  });

  test("reconstructs step-wise seat history from audit events and current seats", () => {
    const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"];
    const history = buildSeatHistorySeries({
      days,
      events: [
        {
          createdAt: new Date("2026-10-20T12:00:00.000Z"),
          seats: 2,
          source: "audit",
        },
        {
          createdAt: new Date("2026-11-02T10:00:00.000Z"),
          seats: 4,
          source: "audit",
        },
        {
          createdAt: new Date("2026-11-02T18:00:00.000Z"),
          seats: 5,
          source: "audit",
        },
      ],
      currentSeats: 6,
      todayKey: "2026-11-04",
    });

    expect(history).toEqual([
      { date: "2026-11-01", seats: 2, source: "audit" },
      { date: "2026-11-02", seats: 5, source: "audit" },
      { date: "2026-11-03", seats: 5, source: "audit" },
      { date: "2026-11-04", seats: 6, source: "current" },
    ]);
  });
});

describe("CSV export", () => {
  test("escapes quotes, commas, newlines, and neutralizes spreadsheet formulas", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell('a, "b"')).toBe('"a, ""b"""');
    expect(escapeCsvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(escapeCsvCell("+1+2")).toBe("'+1+2");
    expect(escapeCsvCell("-cmd")).toBe("'-cmd");
    expect(escapeCsvCell("@evil")).toBe("'@evil");
  });

  test("serializes visible personal and organization series without leaking unpopulated sections", () => {
    const baseDashboard: UsageDashboard = {
      scope: "organization",
      payerLabel: "Acme Lab",
      organization: { id: "org_1", name: "Acme Lab" },
      organizations: [{ id: "org_1", name: "Acme Lab" }],
      period: {
        id: "current_month",
        label: "November 2026 (UTC)",
        startIso: "2026-11-01T00:00:00.000Z",
        endIso: "2026-12-01T00:00:00.000Z",
        isCalendarMonth: true,
      },
      ai: {
        monthlyCapDollars: 100,
        spentDollars: 3.5,
        reservedDollars: 0.25,
        totalProjectedDollars: 3.75,
        capUtilizationPercent: 3.8,
        pendingRequests: 1,
        needsReview: false,
        totalInputTokens: 2000,
        totalOutputTokens: 800,
        daily: [
          {
            date: "2026-11-01",
            chargedDollars: 3.5,
            reservedDollars: 0.25,
            cumulativeDollars: 3.75,
            inputTokens: 2000,
            outputTokens: 800,
            requests: 4,
          },
        ],
        byModel: [
          {
            model: "openai/gpt-5",
            chargedDollars: 3.5,
            reservedDollars: 0.25,
            inputTokens: 2000,
            outputTokens: 800,
            requests: 4,
          },
        ],
        byProject: [
          {
            projectId: "proj_1",
            projectName: "=Paper, 2026",
            chargedDollars: 3.5,
            reservedDollars: 0.25,
            inputTokens: 2000,
            outputTokens: 800,
            requests: 4,
          },
        ],
        byMember: [
          {
            userId: "user_1",
            name: "Ada",
            email: "ada@example.com",
            chargedDollars: 3.5,
            reservedDollars: 0.25,
            inputTokens: 2000,
            outputTokens: 800,
            requests: 4,
          },
        ],
        stripeMeterSummary: {
          status: "unavailable",
          totalDollars: null,
          daily: [],
        },
      },
      compiles: {
        total: 3,
        succeeded: 2,
        failed: 1,
        totalMinutes: 1.25,
        daily: [
          {
            date: "2026-11-01",
            succeeded: 2,
            failed: 1,
            total: 3,
            minutes: 1.25,
          },
        ],
        byProject: [
          {
            projectId: "proj_1",
            projectName: "=Paper, 2026",
            total: 3,
            succeeded: 2,
            failed: 1,
            minutes: 1.25,
          },
        ],
      },
      storage: {
        sourceBytes: "4096",
        projectCount: 1,
        byProject: [
          {
            projectId: "proj_1",
            projectName: "=Paper, 2026",
            sourceBytes: "4096",
          },
        ],
      },
      seats: {
        currentSeats: 4,
        memberCount: 4,
        monthlyRateUsd: 20,
        history: [{ date: "2026-11-01", seats: 4, source: "current" }],
      },
      billing: {
        hasStripeCustomer: true,
        subscriptionStatus: "active",
        plan: "team",
        periodEnd: "2026-12-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        estimatedInvoice: {
          status: "unavailable",
          subtotalDollars: null,
          taxDollars: null,
          totalDollars: null,
          currency: "USD",
          periodStart: null,
          periodEnd: null,
          lines: [],
        },
        invoices: {
          status: "ok",
          items: [
            {
              id: "in_1",
              number: "INV-001",
              createdAt: "2026-11-01T00:00:00.000Z",
              status: "paid",
              subtotalDollars: 80,
              taxDollars: 10.4,
              totalDollars: 90.4,
              currency: "USD",
              hostedInvoiceUrl: "https://invoice.stripe.com/i/1",
              invoicePdf: "https://invoice.stripe.com/i/1/pdf",
            },
          ],
        },
      },
    };

    const csv = formatUsageCsv(baseDashboard);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("record_type,date,payer,member,project,model");
    expect(csv).toContain(
      "daily,2026-11-01,Acme Lab,,,,3.500000,0.250000,3.750000,2000,800,4,2,1,1.25,,4",
    );
    expect(csv).toContain("ai_by_model,,Acme Lab,,,openai/gpt-5,3.500000");
    expect(csv).toContain(
      'ai_by_project,,Acme Lab,,"' + "'=Paper, 2026" + '",,3.500000',
    );
    expect(csv).toContain("ai_by_member,,Acme Lab,ada@example.com,,,3.500000");
    expect(csv).toContain("storage_by_project");
    expect(csv).toContain(
      "invoice,2026-11-01,Acme Lab,,,,,,,,,,,,,,,80.00,10.40,90.40,paid",
    );
  });
});

describe("Stripe billing helpers", () => {
  test("extracts invoice subtotal, tax from total_taxes, and total", async () => {
    const fakeStripe = {
      invoices: {
        list: async () => ({
          data: [
            {
              id: "in_123",
              number: "INV-123",
              created: 1_762_000_000,
              status: "paid",
              subtotal: 2000,
              total: 2260,
              total_taxes: [{ amount: 260 }],
              currency: "usd",
              hosted_invoice_url: "https://stripe.test/inv/123",
              invoice_pdf: "https://stripe.test/inv/123.pdf",
            },
          ],
        }),
      },
    } as unknown as Pick<Stripe, "invoices">;

    const result = await fetchStripeInvoices(fakeStripe, "cus_123");
    expect(result.status).toBe("ok");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "in_123",
      number: "INV-123",
      subtotalDollars: 20,
      taxDollars: 2.6,
      totalDollars: 22.6,
      currency: "USD",
    });
  });

  test("degrades gracefully when Stripe invoice call fails", async () => {
    const failingStripe = {
      invoices: {
        list: async () => {
          throw new Error("Stripe timeout");
        },
      },
    } as unknown as Pick<Stripe, "invoices">;

    const result = await fetchStripeInvoices(failingStripe, "cus_123");
    expect(result.status).toBe("unavailable");
    expect(result.items).toEqual([]);
  });

  test("aggregates Stripe meter event summaries in nano-dollars", async () => {
    const fakeStripe = {
      prices: {
        retrieve: async () => ({
          recurring: { meter: "mtr_123" },
        }),
      },
      billing: {
        meters: {
          listEventSummaries: async () => ({
            data: [
              {
                start_time: Math.floor(
                  new Date("2026-11-01T00:00:00.000Z").getTime() / 1000,
                ),
                end_time: Math.floor(
                  new Date("2026-11-02T00:00:00.000Z").getTime() / 1000,
                ),
                aggregated_value: 1.25 * nanoDollars,
              },
              {
                start_time: Math.floor(
                  new Date("2026-11-02T00:00:00.000Z").getTime() / 1000,
                ),
                end_time: Math.floor(
                  new Date("2026-11-03T00:00:00.000Z").getTime() / 1000,
                ),
                aggregated_value: 0.75 * nanoDollars,
              },
            ],
          }),
        },
      },
    } as unknown as Pick<Stripe, "prices" | "billing">;

    const result = await fetchStripeMeterSummary({
      stripeClient: fakeStripe,
      customerId: "cus_123",
      aiPriceId: "price_ai",
      start: new Date("2026-11-01T00:00:00.000Z"),
      end: new Date("2026-11-03T00:00:00.000Z"),
    });
    expect(result.status).toBe("ok");
    expect(result.totalDollars).toBe(2);
    expect(result.daily).toEqual([
      { date: "2026-11-01", dollars: 1.25 },
      { date: "2026-11-02", dollars: 0.75 },
    ]);
  });
});

describe("getUsageDashboard authorization", () => {
  const mockDbWithMemberships = (
    memberships: {
      organizationId: string;
      role: string;
      organization: {
        id: string;
        name: string;
        stripeCustomerId: string | null;
      };
    }[],
  ) =>
    ({
      query: {
        member: {
          findMany: async () => memberships,
        },
      },
    }) as unknown as Parameters<typeof getUsageDashboard>[0];

  test("rejects non-member access to an organization with 404", async () => {
    const db = mockDbWithMemberships([]);
    await expect(
      getUsageDashboard(db, {
        userId: "user_outsider",
        organizationId: "org_secret",
      }),
    ).rejects.toThrow(BillingError);

    try {
      await getUsageDashboard(db, {
        userId: "user_outsider",
        organizationId: "org_secret",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(BillingError);
      expect((err as BillingError).status).toBe(404);
    }
  });

  test("rejects regular member access to organization usage with 403", async () => {
    const db = mockDbWithMemberships([
      {
        organizationId: "org_1",
        role: "member",
        organization: {
          id: "org_1",
          name: "Acme Lab",
          stripeCustomerId: "cus_org_1",
        },
      },
    ]);

    try {
      await getUsageDashboard(db, {
        userId: "user_member",
        organizationId: "org_1",
      });
      throw new Error("Expected 403 BillingError");
    } catch (err) {
      expect(err).toBeInstanceOf(BillingError);
      expect((err as BillingError).status).toBe(403);
    }
  });
});
