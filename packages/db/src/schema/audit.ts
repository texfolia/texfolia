import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "../auth-schema";

export type AuditMetadataValue =
  | string
  | number
  | boolean
  | null
  | AuditMetadataValue[]
  | { [key: string]: AuditMetadataValue };

export type AuditMetadata = Record<string, AuditMetadataValue>;

/**
 * Append-only audit log of sensitive organization actions (invites, membership
 * and role changes, teams, billing, and org-owned project sharing).
 *
 * Writes are server-side only; org members cannot edit or delete entries.
 * Never store secrets, webhook secrets, access tokens, or raw share tokens in
 * `metadata`.
 */
export const organizationAuditEvent = pgTable(
  "organization_audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<AuditMetadata>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("organization_audit_event_org_created_at_idx").on(
      t.organizationId,
      t.createdAt,
    ),
    index("organization_audit_event_actor_user_id_idx").on(t.actorUserId),
  ],
);
