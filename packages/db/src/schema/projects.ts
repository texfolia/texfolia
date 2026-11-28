import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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

import { organization, user } from "../auth-schema";

const NIL_UUID = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

// Can edit, can comment, or can view. Collaborators, teams, share links, and
// the organization-wide level all grant one of these.
export const projectRole = pgEnum("project_role", [
  "editor",
  "commenter",
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
    formatIndent: integer("format_indent").notNull().default(2),
    formatWrap: boolean("format_wrap").notNull().default(true),
    formatWidth: integer("format_width").notNull().default(80),
    // A BCP 47 tag from the web app's bundled dictionaries, or "off".
    spellcheckLanguage: text("spellcheck_language").notNull().default("en-US"),
    // The path of the document to compile. It follows renames, and is kept when
    // the file is deleted. Null, or a missing file, means main.tex or the first
    // .tex file.
    mainFile: text("main_file"),
    // What every member of the owning organization may do, like Google Docs'
    // general access. Null means only the organization's owners and admins,
    // plus the people and teams granted access. Every member could edit before
    // roles existed, hence the default. Personal projects ignore it.
    organizationRole: projectRole("organization_role").default("editor"),
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
    check("project_format_indent", sql`${t.formatIndent} BETWEEN 1 AND 8`),
    check("project_format_width", sql`${t.formatWidth} BETWEEN 40 AND 200`),
    uniqueIndex("project_owner_id_name_idx")
      .on(t.ownerId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    index("project_organization_id_idx").on(t.organizationId),
    // The unique index above skips the trash.
    index("project_owner_id_idx").on(t.ownerId),
    index("project_deleted_at_idx")
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
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
  // Null only for legacy Texfolia-hosted repositories, which can be read, linked
  // to an empty remote or unlinked (NAT-413). New rows always have a remote.
  provider: text("provider"),
  url: text("url"),
  // Working clone of the remote, cached so actions need not re-clone.
  objectKey: text("object_key").notNull(),
  // Current branch, cached so opening a project needn't restore the repository.
  branch: text("branch"),
});

export const tag = pgTable(
  "tag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => [unique("tag_user_name_unique").on(t.userId, t.name)],
);

export const projectTag = pgTable(
  "project_tag",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tag.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.tagId] }),
    index("project_tag_tag_id_idx").on(t.tagId),
  ],
);

// Deliberately independent of project: cleanup must survive owner cascades.
export const projectCollaboration = pgTable(
  "project_collaboration",
  {
    projectId: uuid("project_id").primaryKey(),
    // Set in the transaction that deletes files, until the room confirms it
    // dropped their documents. Other rooms of live projects are left asleep.
    cleanupRequestedAt: timestamp("cleanup_requested_at", {
      withTimezone: true,
    }),
  },
  (t) => [
    index("project_collaboration_cleanup_idx")
      .on(t.cleanupRequestedAt)
      .where(sql`${t.cleanupRequestedAt} IS NOT NULL`),
  ],
);

// Source object keys that a node stopped referencing. Like the registry above,
// it has no foreign key, so pending cleanup survives owner cascades. Every
// upload writes to a unique key, so a retired key is never reused; collection
// waits out in-flight readers, skips any key still referenced by a live node,
// deletes the objects, and removes the rows.
export const sourceGarbage = pgTable(
  "source_garbage",
  {
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    projectId: uuid("project_id").notNull(),
    objectKey: text("object_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("source_garbage_project_id_idx").on(t.projectId, t.objectKey),
    index("source_garbage_created_at_idx").on(t.createdAt),
  ],
);

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
    // Durable compile duration in milliseconds (survives timeline pruning).
    durationMs: integer("duration_ms"),
    // User-facing compile timeline: compiler stage timing plus browser preview
    // timing. Only the most recent jobs per project keep it.
    timing: jsonb("timing").$type<unknown>(),
  },
  (t) => [
    index("project_job_project_id_created_at_idx").on(t.projectId, t.createdAt),
    check(
      "project_job_object_size_check",
      sql`${t.sizeBytes} >= 0 AND (${t.objectKey} IS NOT NULL OR ${t.sizeBytes} = 0)`,
    ),
    check(
      "project_job_duration_ms_check",
      sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`,
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
    // Also serves project cascades, which include deleted nodes.
    index("project_node_project_id_object_key_idx").on(
      t.projectId,
      t.objectKey,
    ),
    check(
      "nodes_kind_payload_check",
      sql`(${t.kind} = 'folder' AND ${t.objectKey} IS NULL AND ${t.sizeBytes} = 0)
        OR ${t.kind} = 'text'
        OR (${t.kind} = 'binary' AND ${t.objectKey} IS NOT NULL)`,
    ),
  ],
);
