import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth-schema";

export const templateVisibility = pgEnum("template_visibility", [
  "public",
  "unlisted",
]);
export const templateStatus = pgEnum("template_status", [
  "building",
  "pending",
  "approved",
  "rejected",
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
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    publisherName: text("publisher_name").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    tags: text("tags").array().notNull(),
    license: templateLicense("license").notNull(),
    visibility: templateVisibility("visibility").notNull(),
    status: templateStatus("status").notNull().default("building"),
    mainFile: text("main_file").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    previewKey: text("preview_key"),
    previewCheckedAt: timestamp("preview_checked_at", { withTimezone: true }),
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
      table.status,
      table.previewCheckedAt,
      table.createdAt,
    ),
    check(
      "template_ready_preview_check",
      sql`${table.status} NOT IN ('approved', 'pending') OR ${table.previewKey} IS NOT NULL`,
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
