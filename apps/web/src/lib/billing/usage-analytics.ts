import { nanoDollars } from "./usage";

export const usagePeriods = [
  "current_month",
  "previous_month",
  "last_30_days",
  "last_90_days",
] as const;

export type UsagePeriod = (typeof usagePeriods)[number];

export type ResolvedUsagePeriod = {
  id: UsagePeriod;
  label: string;
  start: Date;
  /** Exclusive upper bound for queries. */
  end: Date;
  /** Inclusive UTC YYYY-MM-DD day keys covering the chart axis. */
  days: string[];
  /** True when the period is a single UTC calendar month (matches monthly cap). */
  isCalendarMonth: boolean;
};

export type DailyAiPoint = {
  date: string;
  chargedDollars: number;
  reservedDollars: number;
  cumulativeDollars: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

export type AiModelBreakdown = {
  model: string;
  chargedDollars: number;
  reservedDollars: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

export type AiProjectBreakdown = {
  projectId: string;
  projectName: string;
  chargedDollars: number;
  reservedDollars: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

export type AiMemberBreakdown = {
  userId: string;
  name: string;
  email: string;
  chargedDollars: number;
  reservedDollars: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

export type DailyCompilePoint = {
  date: string;
  succeeded: number;
  failed: number;
  total: number;
  minutes: number;
};

export type ProjectCompileBreakdown = {
  projectId: string;
  projectName: string;
  total: number;
  succeeded: number;
  failed: number;
  minutes: number;
};

export type ProjectStorageBreakdown = {
  projectId: string;
  projectName: string;
  sourceBytes: string;
};

export type SeatHistoryPoint = {
  date: string;
  seats: number;
  source: "audit" | "membership" | "current";
};

export type StripeMeterSummary = {
  status: "ok" | "unavailable";
  totalDollars: number | null;
  daily: { date: string; dollars: number }[];
  note?: string;
};

export type EstimatedInvoiceLine = {
  description: string;
  amountDollars: number;
  quantity: number | null;
};

export type EstimatedInvoice = {
  status: "available" | "unavailable";
  subtotalDollars: number | null;
  taxDollars: number | null;
  totalDollars: number | null;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  lines: EstimatedInvoiceLine[];
  note?: string;
};

export type InvoiceRecord = {
  id: string;
  number: string | null;
  createdAt: string;
  status: string | null;
  subtotalDollars: number;
  taxDollars: number;
  totalDollars: number;
  currency: string;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
};

export type UsageDashboard = {
  scope: "personal" | "organization";
  payerLabel: string;
  organization: { id: string; name: string } | null;
  organizations: { id: string; name: string }[];
  period: {
    id: UsagePeriod;
    label: string;
    startIso: string;
    endIso: string;
    isCalendarMonth: boolean;
  };
  ai: {
    monthlyCapDollars: number;
    spentDollars: number;
    reservedDollars: number;
    totalProjectedDollars: number;
    capUtilizationPercent: number;
    pendingRequests: number;
    needsReview: boolean;
    totalInputTokens: number;
    totalOutputTokens: number;
    daily: DailyAiPoint[];
    byModel: AiModelBreakdown[];
    byProject: AiProjectBreakdown[];
    byMember: AiMemberBreakdown[];
    stripeMeterSummary: StripeMeterSummary;
  };
  compiles: {
    total: number;
    succeeded: number;
    failed: number;
    totalMinutes: number;
    daily: DailyCompilePoint[];
    byProject: ProjectCompileBreakdown[];
  };
  storage: {
    sourceBytes: string;
    projectCount: number;
    byProject: ProjectStorageBreakdown[];
  };
  seats: {
    currentSeats: number;
    memberCount: number;
    monthlyRateUsd: number;
    history: SeatHistoryPoint[];
  } | null;
  billing: {
    hasStripeCustomer: boolean;
    subscriptionStatus: string | null;
    plan: string | null;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    estimatedInvoice: EstimatedInvoice;
    invoices: {
      status: "ok" | "unavailable";
      items: InvoiceRecord[];
      note?: string;
    };
  };
};

export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function enumerateUtcDays(start: Date, endExclusive: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  while (cursor < endExclusive) {
    days.push(utcDayKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

const monthFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function resolveUsagePeriod(
  period: UsagePeriod = "current_month",
  now = new Date(),
): ResolvedUsagePeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const tomorrowUtc = new Date(Date.UTC(year, month, day + 1));

  if (period === "current_month") {
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 1));
    const chartEnd = tomorrowUtc < end ? tomorrowUtc : end;
    return {
      id: period,
      label: `${monthFormatter.format(start)} (UTC)`,
      start,
      end,
      days: enumerateUtcDays(start, chartEnd),
      isCalendarMonth: true,
    };
  }

  if (period === "previous_month") {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    return {
      id: period,
      label: `${monthFormatter.format(start)} (UTC)`,
      start,
      end,
      days: enumerateUtcDays(start, end),
      isCalendarMonth: true,
    };
  }

  const spanDays = period === "last_30_days" ? 30 : 90;
  const start = new Date(Date.UTC(year, month, day - (spanDays - 1)));
  return {
    id: period,
    label:
      period === "last_30_days" ? "Last 30 days (UTC)" : "Last 90 days (UTC)",
    start,
    end: tomorrowUtc,
    days: enumerateUtcDays(start, tomorrowUtc),
    isCalendarMonth: false,
  };
}

export function roundDollars(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function roundMinutes(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round((ms / 60_000) * 100) / 100;
}

export function computeCapUtilizationPercent(
  projectedDollars: number,
  monthlyCapDollars: number,
): number {
  if (monthlyCapDollars <= 0) return projectedDollars > 0 ? 100 : 0;
  return Math.round((projectedDollars / monthlyCapDollars) * 1000) / 10;
}

export type RawDailyAiRow = {
  day: string;
  chargedNanos: number;
  reservedNanos: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
};

export function buildDailyAiSeries(
  days: string[],
  rows: RawDailyAiRow[],
): DailyAiPoint[] {
  const byDay = new Map<string, RawDailyAiRow>();
  for (const row of rows) {
    byDay.set(row.day, row);
  }
  let cumulativeNanos = 0;
  return days.map((date) => {
    const row = byDay.get(date);
    const chargedNanos = row?.chargedNanos ?? 0;
    const reservedNanos = row?.reservedNanos ?? 0;
    cumulativeNanos += chargedNanos + reservedNanos;
    return {
      date,
      chargedDollars: roundDollars(chargedNanos / nanoDollars),
      reservedDollars: roundDollars(reservedNanos / nanoDollars),
      cumulativeDollars: roundDollars(cumulativeNanos / nanoDollars),
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      requests: row?.requests ?? 0,
    };
  });
}

export type RawDailyCompileRow = {
  day: string;
  succeeded: number;
  failed: number;
  total: number;
  durationMs: number;
};

export function buildDailyCompileSeries(
  days: string[],
  rows: RawDailyCompileRow[],
): DailyCompilePoint[] {
  const byDay = new Map<string, RawDailyCompileRow>();
  for (const row of rows) {
    byDay.set(row.day, row);
  }
  return days.map((date) => {
    const row = byDay.get(date);
    return {
      date,
      succeeded: row?.succeeded ?? 0,
      failed: row?.failed ?? 0,
      total: row?.total ?? 0,
      minutes: roundMinutes(row?.durationMs ?? 0),
    };
  });
}

export type SeatChangeEvent = {
  createdAt: Date;
  seats: number;
  source: "audit" | "membership";
};

/**
 * Builds a daily seat-count series over `days` from historical seat events
 * (organization audit events and/or member join timestamps) and the current
 * seat count.
 */
export function buildSeatHistorySeries({
  days,
  events,
  currentSeats,
  todayKey,
}: {
  days: string[];
  events: SeatChangeEvent[];
  currentSeats: number;
  todayKey: string;
}): SeatHistoryPoint[] {
  if (!days.length) return [];
  const sorted = [...events].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const firstDay = days[0]!;
  let activeSeats: number | null = null;
  let activeSource: SeatHistoryPoint["source"] = "current";
  const eventsByDay = new Map<string, SeatChangeEvent>();

  for (const event of sorted) {
    const key = utcDayKey(event.createdAt);
    if (key < firstDay) {
      activeSeats = event.seats;
      activeSource = event.source;
    } else {
      eventsByDay.set(key, event);
    }
  }

  // If no historical event preceded the window, seed with currentSeats only if
  // there are no events at all; otherwise start from 0 until the first event.
  if (activeSeats === null && eventsByDay.size === 0) {
    activeSeats = currentSeats;
    activeSource = "current";
  }

  return days.map((date) => {
    const event = eventsByDay.get(date);
    if (event) {
      activeSeats = event.seats;
      activeSource = event.source;
    }
    if (date === todayKey) {
      return { date, seats: currentSeats, source: "current" };
    }
    return {
      date,
      seats: activeSeats ?? 0,
      source: activeSource,
    };
  });
}

const formulaPrefix = /^[=+\-@\t\r]/;

export function escapeCsvCell(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  let str = String(value);
  if (typeof value === "string" && formulaPrefix.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

const CSV_HEADERS = [
  "record_type",
  "date",
  "payer",
  "member",
  "project",
  "model",
  "charged_usd_pre_tax",
  "reserved_usd_pre_tax",
  "cumulative_usd_pre_tax",
  "input_tokens",
  "output_tokens",
  "ai_requests",
  "compiles_succeeded",
  "compiles_failed",
  "compile_minutes",
  "storage_bytes",
  "seats",
  "invoice_subtotal_usd",
  "invoice_tax_usd",
  "invoice_total_usd",
  "invoice_status",
] as const;

export function formatUsageCsv(dashboard: UsageDashboard): string {
  const rows: (string | number | null | undefined)[][] = [];
  const payer = dashboard.payerLabel;
  const compileByDay = new Map(
    dashboard.compiles.daily.map((point) => [point.date, point]),
  );
  const seatsByDay = new Map(
    (dashboard.seats?.history ?? []).map((point) => [point.date, point.seats]),
  );

  for (const day of dashboard.ai.daily) {
    const compile = compileByDay.get(day.date);
    const seats = seatsByDay.get(day.date);
    rows.push([
      "daily",
      day.date,
      payer,
      "",
      "",
      "",
      day.chargedDollars.toFixed(6),
      day.reservedDollars.toFixed(6),
      day.cumulativeDollars.toFixed(6),
      day.inputTokens,
      day.outputTokens,
      day.requests,
      compile?.succeeded ?? 0,
      compile?.failed ?? 0,
      compile ? compile.minutes.toFixed(2) : "0.00",
      "",
      seats ?? "",
      "",
      "",
      "",
      "",
    ]);
  }

  for (const item of dashboard.ai.byModel) {
    rows.push([
      "ai_by_model",
      "",
      payer,
      "",
      "",
      item.model,
      item.chargedDollars.toFixed(6),
      item.reservedDollars.toFixed(6),
      "",
      item.inputTokens,
      item.outputTokens,
      item.requests,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  }

  for (const item of dashboard.ai.byProject) {
    rows.push([
      "ai_by_project",
      "",
      payer,
      "",
      item.projectName,
      "",
      item.chargedDollars.toFixed(6),
      item.reservedDollars.toFixed(6),
      "",
      item.inputTokens,
      item.outputTokens,
      item.requests,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  }

  for (const item of dashboard.ai.byMember) {
    rows.push([
      "ai_by_member",
      "",
      payer,
      item.email || item.name,
      "",
      "",
      item.chargedDollars.toFixed(6),
      item.reservedDollars.toFixed(6),
      "",
      item.inputTokens,
      item.outputTokens,
      item.requests,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  }

  for (const item of dashboard.compiles.byProject) {
    rows.push([
      "compiles_by_project",
      "",
      payer,
      "",
      item.projectName,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      item.succeeded,
      item.failed,
      item.minutes.toFixed(2),
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  }

  for (const item of dashboard.storage.byProject) {
    rows.push([
      "storage_by_project",
      "",
      payer,
      "",
      item.projectName,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      item.sourceBytes,
      "",
      "",
      "",
      "",
      "",
    ]);
  }

  for (const invoice of dashboard.billing.invoices.items) {
    rows.push([
      "invoice",
      invoice.createdAt.slice(0, 10),
      payer,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      invoice.subtotalDollars.toFixed(2),
      invoice.taxDollars.toFixed(2),
      invoice.totalDollars.toFixed(2),
      invoice.status ?? "",
    ]);
  }

  const lines = [
    CSV_HEADERS.join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(",")),
  ];
  return `${lines.join("\n")}\n`;
}
