import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

export const aiRunStatus = pgEnum("ai_run_status", [
  "running",
  "succeeded",
  "failed",
  "aborted",
]);
export const aiRequestStatus = pgEnum("ai_request_status", [
  "pending",
  "priced",
  "reported",
  "needs_review",
]);
const money = (name: string) => bigint(name, { mode: "number" });
const time = (name: string) => timestamp(name, { withTimezone: true });

export const aiSettings = pgTable(
  "ai_settings",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    defaultModel: text("default_model"),
    monthlyCapNanos: money("monthly_cap_nanos")
      .notNull()
      .default(20_000_000_000),
  },
  (t) => [
    check(
      "ai_cap_nonnegative",
      sql`${t.monthlyCapNanos} between 0 and 10000000000000`,
    ),
  ],
);

// Billing records survive account/project deletion and retain the original payer.
export const aiRun = pgTable(
  "ai_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    clientRunId: text("client_run_id").notNull(),
    projectId: uuid("project_id").notNull(),
    model: text("model").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    accountId: text("account_id").notNull(),
    gatewayId: text("gateway_id").notNull(),
    meterEventName: text("meter_event_name").notNull(),
    markupPercent: integer("markup_percent").notNull().default(20),
    status: aiRunStatus("status").notNull().default("running"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: time("created_at").notNull().defaultNow(),
    finishedAt: time("finished_at"),
  },
  (t) => [
    index("ai_run_user_created_idx").on(t.userId, t.createdAt),
    uniqueIndex("ai_run_user_client_idx").on(t.userId, t.clientRunId),
  ],
);

export const aiRequest = pgTable(
  "ai_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => aiRun.id),
    logId: text("log_id").unique(),
    model: text("model").notNull(),
    status: aiRequestStatus("status").notNull().default("pending"),
    reservedNanos: money("reserved_nanos").notNull(),
    baseCostNanos: money("base_cost_nanos"),
    chargedNanos: money("charged_nanos"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: time("next_attempt_at").notNull().defaultNow(),
    error: text("error"),
    createdAt: time("created_at").notNull().defaultNow(),
    reportedAt: time("reported_at"),
    reportStartedAt: time("report_started_at"),
  },
  (t) => [
    index("ai_request_retry_idx").on(t.status, t.nextAttemptAt),
    check(
      "ai_request_nonnegative",
      sql`${t.reservedNanos} >= 0 AND (${t.chargedNanos} IS NULL OR ${t.chargedNanos} >= 0)`,
    ),
  ],
);
