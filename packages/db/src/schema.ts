import { defineRelations, sql } from "drizzle-orm";
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
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth-schema";

export * from "./auth-schema";

const NIL_UUID = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

export const projectCollaboratorRole = pgEnum("project_collaborator_role", [
  "editor",
  "viewer",
]);

export const projectNodeKind = pgEnum("project_node_kind", [
  "folder",
  "text",
  "binary",
]);

export const projectJobStatus = pgEnum("project_job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("project_owner_id_name_idx")
      .on(t.ownerId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    index("project_organization_id_idx").on(t.organizationId),
    check(
      "project_owner_check",
      sql`(${t.ownerId} IS NOT NULL AND ${t.organizationId} IS NULL) OR (${t.ownerId} IS NULL AND ${t.organizationId} IS NOT NULL)`,
    ),
  ],
);

export const projectGit = pgTable("project_git", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  url: text("url").notNull(),
  objectKey: text("object_key").notNull(),
});

export const projectCollaborator = pgTable(
  "project_collaborator",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: projectCollaboratorRole("role").notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index("project_collaborator_user_id_idx").on(table.userId),
  ],
);

// Deliberately independent of project: cleanup must survive owner cascades.
export const projectCollaboration = pgTable("project_collaboration", {
  projectId: uuid("project_id").primaryKey(),
});

export const projectJob = pgTable(
  "project_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    status: projectJobStatus("status").notNull().default("queued"),
    requestDigest: text("request_digest"),
    objectKey: text("object_key"),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    log: text("log"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("project_job_project_id_created_at_idx").on(t.projectId, t.createdAt),
    check(
      "project_job_object_size_check",
      sql`${t.sizeBytes} >= 0 AND (${t.objectKey} IS NOT NULL OR ${t.sizeBytes} = 0)`,
    ),
  ],
);

export const projectNode = pgTable(
  "project_node",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    kind: projectNodeKind("kind").notNull(),
    objectKey: text("object_key"),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "project_node_object_size_check",
      sql`${t.sizeBytes} >= 0 AND (${t.objectKey} IS NOT NULL OR ${t.sizeBytes} = 0)`,
    ),
    uniqueIndex("nodes_sibling_name_unique")
      .on(
        t.projectId,
        sql`coalesce(${t.parentId}, ${NIL_UUID})`,
        sql`lower(${t.name})`,
      )
      .where(sql`${t.deletedAt} IS NULL`),
    check(
      "nodes_kind_payload_check",
      sql`(${t.kind} = 'folder' AND ${t.objectKey} IS NULL AND ${t.sizeBytes} = 0)
        OR ${t.kind} = 'text'
        OR (${t.kind} = 'binary' AND ${t.objectKey} IS NOT NULL)`,
    ),
  ],
);

export const relations = defineRelations(
  {
    project,
    projectCollaborator,
    projectJob,
    projectNode,
    user,
  },
  (r) => ({
    project: {
      collaborators: r.many.projectCollaborator(),
      jobs: r.many.projectJob(),
      nodes: r.many.projectNode(),
      owner: r.one.user({
        from: r.project.ownerId,
        to: r.user.id,
      }),
    },
    projectCollaborator: {
      project: r.one.project({
        from: r.projectCollaborator.projectId,
        to: r.project.id,
      }),
      user: r.one.user({
        from: r.projectCollaborator.userId,
        to: r.user.id,
      }),
    },
    projectJob: {
      project: r.one.project({
        from: r.projectJob.projectId,
        to: r.project.id,
      }),
    },
    projectNode: {
      children: r.many.projectNode({
        from: r.projectNode.id,
        to: r.projectNode.parentId,
      }),
      parent: r.one.projectNode({
        from: r.projectNode.parentId,
        to: r.projectNode.id,
      }),
      project: r.one.project({
        from: r.projectNode.projectId,
        to: r.project.id,
      }),
    },
    user: {
      ownedProjects: r.many.project({
        from: r.user.id,
        to: r.project.ownerId,
      }),
      projectCollaborations: r.many.projectCollaborator({
        from: r.user.id,
        to: r.projectCollaborator.userId,
      }),
    },
  }),
);

export const templateVisibility = pgEnum("template_visibility", [
  "public",
  "unlisted",
]);
export const templateStatus = pgEnum("template_status", [
  "pending",
  "approved",
  "rejected",
]);
export const templatePreviewStatus = pgEnum("template_preview_status", [
  "queued",
  "ready",
  "failed",
]);
export const templateLicense = pgEnum("template_license", [
  "CC0-1.0",
  "CC-BY-4.0",
  "MIT",
  "LPPL-1.3c",
]);

export const template = pgTable(
  "template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    publisherName: text("publisher_name").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    tags: text("tags").array().notNull(),
    license: templateLicense("license").notNull(),
    visibility: templateVisibility("visibility").notNull(),
    status: templateStatus("status").notNull().default("pending"),
    mainFile: text("main_file").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    previewKey: text("preview_key"),
    previewStatus: templatePreviewStatus("preview_status")
      .notNull()
      .default("queued"),
    previewJobId: uuid("preview_job_id").notNull().defaultRandom(),
    previewStartedAt: timestamp("preview_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    previewNextAttemptAt: timestamp("preview_next_attempt_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("template_gallery_idx").on(
      table.visibility,
      table.status,
      table.createdAt,
    ),
    index("template_publisher_idx").on(table.ownerId, table.createdAt),
    index("template_preview_queue_idx").on(
      table.previewStatus,
      table.previewNextAttemptAt,
    ),
    check(
      "template_ready_preview_check",
      sql`(${table.previewStatus} = 'ready') = (${table.previewKey} IS NOT NULL)`,
    ),
    check(
      "template_curated_owner_check",
      sql`${table.ownerId} IS NOT NULL OR ${table.organizationId} IS NULL`,
    ),
  ],
);

export const templateReport = pgTable(
  "template_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => template.id, { onDelete: "cascade" }),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("template_report_per_user").on(table.templateId, table.reporterId),
    index("template_report_queue_idx").on(table.resolvedAt, table.createdAt),
  ],
);

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
