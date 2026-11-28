import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "../auth-schema";
import { projectComment, projectCommentThread } from "./comments";
import { project } from "./projects";

export const notificationKind = pgEnum("notification_kind", [
  "comment_mention",
  "scratchpad_mention",
]);

/** Per-user in-app notifications, e.g. when mentioned in a comment or scratchpad. */
export const userNotification = pgTable(
  "user_notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    kind: notificationKind("kind").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => projectCommentThread.id, {
      onDelete: "cascade",
    }),
    commentId: uuid("comment_id").references(() => projectComment.id, {
      onDelete: "cascade",
    }),
    excerpt: text("excerpt").notNull().default(""),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("user_notification_user_id_created_at_idx").on(t.userId, t.createdAt),
    index("user_notification_user_id_read_at_idx").on(t.userId, t.readAt),
    index("user_notification_actor_id_idx").on(t.actorId),
    index("user_notification_project_id_idx").on(t.projectId),
    index("user_notification_thread_id_idx").on(t.threadId),
    index("user_notification_comment_id_idx").on(t.commentId),
  ],
);
