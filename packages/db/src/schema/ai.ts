import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "../auth-schema";
import { project } from "./projects";

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

/**
 * An organization's shared monthly AI spend cap. Only organization owners and
 * admins change it; it bounds every member's usage billed to the organization,
 * on top of each member's own cap.
 */
export const aiOrganizationSettings = pgTable(
  "ai_organization_settings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    monthlyCapNanos: money("monthly_cap_nanos")
      .notNull()
      .default(100_000_000_000),
  },
  (t) => [
    check(
      "ai_organization_cap_nonnegative",
      sql`${t.monthlyCapNanos} between 0 and 10000000000000`,
    ),
  ],
);

export const aiThread = pgTable(
  "ai_thread",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    model: text("model"),
    activeRunId: text("active_run_id"),
    activeRunAt: time("active_run_at"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("ai_thread_user_project_idx").on(t.userId, t.projectId, t.updatedAt),
    index("ai_thread_project_id_idx").on(t.projectId),
  ],
);

export const aiMessage = pgTable(
  "ai_message",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => aiThread.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    position: integer("position").notNull(),
    message: jsonb("message").$type<unknown>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.id] }),
    uniqueIndex("ai_message_thread_position_idx").on(t.threadId, t.position),
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
    // Payer-keyed spend: an organization's cap sums every run billed to it.
    index("ai_run_customer_created_idx").on(t.stripeCustomerId, t.createdAt),
    uniqueIndex("ai_run_user_client_idx").on(t.userId, t.clientRunId),
    // Reconciliation looks for abandoned runs every minute.
    index("ai_run_status_created_idx").on(t.status, t.createdAt),
  ],
);

// Subscriptions known to have the AI usage price, so a run need not ask Stripe.
export const aiMeterAttachment = pgTable("ai_meter_attachment", {
  stripeSubscriptionId: text("stripe_subscription_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  priceId: text("price_id").notNull(),
  meterEventName: text("meter_event_name").notNull(),
  checkedAt: time("checked_at").notNull(),
});

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
    index("ai_request_run_id_idx").on(t.runId),
    check(
      "ai_request_nonnegative",
      sql`${t.reservedNanos} >= 0 AND (${t.chargedNanos} IS NULL OR ${t.chargedNanos} >= 0)`,
    ),
  ],
);
