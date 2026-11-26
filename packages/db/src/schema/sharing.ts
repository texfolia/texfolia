import {
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { team, user } from "../auth-schema";
import { project, projectRole } from "./projects";

// People granted access to one project. On an organization project they must be
// members of the organization; the grant stops applying when they leave it.
export const projectCollaborator = pgTable(
  "project_collaborator",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: projectRole("role").notNull().default("viewer"),
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

// Capability links. Anyone may redeem a view link; comment and edit links need
// an account. Only the token's SHA-256 is stored; the token itself is returned
// once, when the link is created.
export const projectShareLink = pgTable(
  "project_share_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    role: projectRole("role").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("project_share_link_project_id_idx").on(table.projectId),
    index("project_share_link_created_by_idx").on(table.createdBy),
  ],
);

// An account that redeemed a share link. It has the link's role for as long as
// the link exists: revoking the link deletes these rows.
export const projectShareGrant = pgTable(
  "project_share_grant",
  {
    linkId: uuid("link_id")
      .notNull()
      .references(() => projectShareLink.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.linkId, table.userId] }),
    index("project_share_grant_project_id_user_id_idx").on(
      table.projectId,
      table.userId,
    ),
    index("project_share_grant_user_id_idx").on(table.userId),
  ],
);

// Teams of the owning organization granted access to one of its projects.
export const projectTeam = pgTable(
  "project_team",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    role: projectRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.teamId] }),
    index("project_team_team_id_idx").on(table.teamId),
  ],
);

export const sharingLimitWindow = pgEnum("sharing_limit_window", [
  "minute",
  "day",
]);

/** Counts a user's outbound sharing emails in the current minute and day. */
export const sharingLimit = pgTable(
  "sharing_limit",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    window: sharingLimitWindow("window").notNull(),
    count: integer("count").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.window] })],
);
