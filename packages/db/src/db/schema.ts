import { defineRelations, sql } from "drizzle-orm";
import {
  bigint,
  bytea,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

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
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
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
  (t) => [uniqueIndex("project_owner_id_name_idx").on(t.ownerId, t.name)],
);

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

export const projectJob = pgTable(
  "project_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    status: projectJobStatus("status").notNull().default("queued"),
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
    unique("project_node_id_kind_unique").on(t.id, t.kind),
    uniqueIndex("nodes_sibling_name_unique")
      .on(
        t.projectId,
        sql`coalesce(${t.parentId}, ${NIL_UUID})`,
        sql`lower(${t.name})`,
      )
      .where(sql`${t.deletedAt} IS NULL`),
    check(
      "nodes_kind_payload_check",
      sql`(${t.kind} IN ('folder', 'text') AND ${t.objectKey} IS NULL)
        OR (${t.kind} = 'binary' AND ${t.objectKey} IS NOT NULL)`,
    ),
  ],
);

export const projectNodeText = pgTable(
  "project_node_text",
  {
    nodeId: uuid("node_id").primaryKey(),
    // The discriminator keeps Yjs state attached only to text nodes.
    kind: projectNodeKind("kind").$type<"text">().notNull().default("text"),
    // Full document state: Buffer.from(Y.encodeStateAsUpdate(doc)).
    yjsState: bytea("yjs_state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("project_node_text_kind_check", sql`${t.kind} = 'text'`),
    foreignKey({
      columns: [t.nodeId, t.kind],
      foreignColumns: [projectNode.id, projectNode.kind],
    }).onDelete("cascade"),
  ],
);

export const relations = defineRelations(
  {
    project,
    projectCollaborator,
    projectJob,
    projectNode,
    projectNodeText,
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
      text: r.one.projectNodeText({
        from: r.projectNode.id,
        to: r.projectNodeText.nodeId,
      }),
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
    projectNodeText: {
      node: r.one.projectNode({
        from: r.projectNodeText.nodeId,
        to: r.projectNode.id,
        optional: false,
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
