import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { user } from "../auth-schema";
import { project, projectNode } from "./projects";

// Review comments anchored to a text range. `anchorStart` and `anchorEnd` are
// base64 Yjs relative positions in the file's collaboration document, so the
// range follows edits. `quote` keeps the original text for display after the
// range is deleted.
export const projectCommentThread = pgTable(
  "project_comment_thread",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => projectNode.id, { onDelete: "cascade" }),
    anchorStart: text("anchor_start").notNull(),
    anchorEnd: text("anchor_end").notNull(),
    quote: text("quote").notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Bumped by every change to the thread or its comments. The workspace
    // metadata poll uses it to notice changes.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("project_comment_thread_project_id_idx").on(t.projectId),
    index("project_comment_thread_node_id_idx").on(t.nodeId),
    index("project_comment_thread_created_by_idx").on(t.createdBy),
    index("project_comment_thread_resolved_by_idx").on(t.resolvedBy),
  ],
);

export const projectComment = pgTable(
  "project_comment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => projectCommentThread.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  (t) => [
    index("project_comment_thread_id_created_at_idx").on(
      t.threadId,
      t.createdAt,
    ),
    index("project_comment_author_id_idx").on(t.authorId),
  ],
);
