import { defineRelations, sql } from "drizzle-orm";
import {
  check,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
    role: projectCollaboratorRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
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
    content: text("content"),
    objectKey: text("object_key"),
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
    uniqueIndex("nodes_sibling_name_unique")
      .on(
        t.projectId,
        sql`coalesce(${t.parentId}, ${NIL_UUID})`,
        sql`lower(${t.name})`,
      )
      .where(sql`${t.deletedAt} IS NULL`),
    check(
      "nodes_kind_payload_check",
      sql`(${t.kind} = 'folder' AND ${t.content} IS NULL AND ${t.objectKey} IS NULL)
        OR (${t.kind} = 'text' AND ${t.content} IS NOT NULL AND ${t.objectKey} IS NULL)
        OR (${t.kind} = 'binary' AND ${t.content} IS NULL AND ${t.objectKey} IS NOT NULL)`,
    ),
  ],
);

export const relations = defineRelations(
  {
    project,
    projectCollaborator,
    projectNode,
    user,
  },
  (r) => ({
    project: {
      collaborators: r.many.projectCollaborator(),
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
  }),
);

export type SelectProject = typeof project.$inferSelect;
export type InsertProject = typeof project.$inferInsert;
export type SelectProjectCollaborator = typeof projectCollaborator.$inferSelect;
export type InsertProjectCollaborator = typeof projectCollaborator.$inferInsert;
export type SelectProjectNode = typeof projectNode.$inferSelect;
export type InsertProjectNode = typeof projectNode.$inferInsert;
