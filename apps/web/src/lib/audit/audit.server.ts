import type { Db } from "@texfolia/db";
import { invitation, organizationAuditEvent, user } from "@texfolia/db/schema";
import { and, desc, eq, like, lt, lte, or } from "drizzle-orm";

import { isOrgAdmin } from "#/lib/auth/roles";

import {
  organizationAuditCategoryPrefixes,
  sanitizeAuditMetadata,
  type OrganizationAuditAction,
  type OrganizationAuditCategory,
  type OrganizationAuditEventRecord,
} from "./audit";

export type OrganizationAuditEventInput = {
  organizationId: string;
  actorUserId?: string | null;
  action: OrganizationAuditAction;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
};

export type AuditWriter = (event: OrganizationAuditEventInput) => Promise<void>;

type AuditDb = Pick<Db, "insert">;

export class AuditAccessError extends Error {
  readonly status = 403;
  constructor(
    message = "Only organization owners and admins can view the audit log.",
  ) {
    super(message);
    this.name = "AuditAccessError";
  }
}

/**
 * Appends one immutable event to `organization_audit_event`.
 * Metadata is sanitized to strip secrets, tokens, and raw share links.
 */
export async function recordOrganizationAuditEvent(
  db: AuditDb,
  event: OrganizationAuditEventInput,
) {
  await db.insert(organizationAuditEvent).values({
    organizationId: event.organizationId,
    actorUserId: event.actorUserId ?? null,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    metadata: sanitizeAuditMetadata(event.metadata),
  });
}

export function createDbAuditWriter(db: Db): AuditWriter {
  return (event) => recordOrganizationAuditEvent(db, event);
}

/**
 * Marks pending invitations past their `expiresAt` as `expired` and records an
 * `invitation.expired` audit event for each newly expired row. Safe to call
 * concurrently because the `UPDATE ... WHERE status = 'pending'` is atomic.
 */
export async function expireOrganizationInvitations(
  db: Db,
  {
    organizationId,
    now = new Date(),
  }: { organizationId?: string; now?: Date } = {},
) {
  const conditions = [
    eq(invitation.status, "pending"),
    lte(invitation.expiresAt, now),
  ];
  if (organizationId)
    conditions.push(eq(invitation.organizationId, organizationId));

  const expired = await db
    .update(invitation)
    .set({ status: "expired" })
    .where(and(...conditions))
    .returning({
      id: invitation.id,
      organizationId: invitation.organizationId,
      email: invitation.email,
      role: invitation.role,
    });

  if (expired.length === 0) return 0;

  await db.insert(organizationAuditEvent).values(
    expired.map((item) => ({
      organizationId: item.organizationId,
      actorUserId: null,
      action: "invitation.expired",
      targetType: "invitation",
      targetId: item.id,
      metadata: sanitizeAuditMetadata({
        email: item.email,
        role: item.role ?? "member",
      }),
    })),
  );
  return expired.length;
}

export type AuditCursor = {
  createdAt: string;
  id: string;
};

/**
 * Lists audit events for an organization, newest first.
 * Strictly restricted to organization owners and admins.
 */
export async function listOrganizationAuditEvents(
  db: Db,
  {
    userId,
    organizationId,
    category = "all",
    limit = 50,
    cursor,
  }: {
    userId: string;
    organizationId: string;
    category?: OrganizationAuditCategory;
    limit?: number;
    cursor?: AuditCursor;
  },
): Promise<{
  events: OrganizationAuditEventRecord[];
  nextCursor: AuditCursor | null;
}> {
  const membership = await db.query.member.findFirst({
    columns: { role: true },
    where: { userId, organizationId },
  });
  if (!membership || !isOrgAdmin(membership.role)) throw new AuditAccessError();

  // Sweep any newly expired invitations for this org so they appear promptly.
  await expireOrganizationInvitations(db, { organizationId });

  const pageSize = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const conditions = [
    eq(organizationAuditEvent.organizationId, organizationId),
  ];
  if (category !== "all") {
    const prefix = organizationAuditCategoryPrefixes[category];
    conditions.push(like(organizationAuditEvent.action, `${prefix}%`));
  }
  if (cursor) {
    const cursorDate = new Date(cursor.createdAt);
    if (!Number.isNaN(cursorDate.getTime())) {
      const cursorCondition = or(
        lt(organizationAuditEvent.createdAt, cursorDate),
        and(
          eq(organizationAuditEvent.createdAt, cursorDate),
          lt(organizationAuditEvent.id, cursor.id),
        ),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
  }

  const rows = await db
    .select({
      id: organizationAuditEvent.id,
      organizationId: organizationAuditEvent.organizationId,
      actorUserId: organizationAuditEvent.actorUserId,
      actorName: user.name,
      actorEmail: user.email,
      action: organizationAuditEvent.action,
      targetType: organizationAuditEvent.targetType,
      targetId: organizationAuditEvent.targetId,
      metadata: organizationAuditEvent.metadata,
      createdAt: organizationAuditEvent.createdAt,
    })
    .from(organizationAuditEvent)
    .leftJoin(user, eq(organizationAuditEvent.actorUserId, user.id))
    .where(and(...conditions))
    .orderBy(
      desc(organizationAuditEvent.createdAt),
      desc(organizationAuditEvent.id),
    )
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page.at(-1);

  return {
    events: page.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      actorUserId: row.actorUserId,
      actor:
        row.actorUserId && row.actorName !== null && row.actorEmail !== null
          ? {
              id: row.actorUserId,
              name: row.actorName,
              email: row.actorEmail,
            }
          : null,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata ?? {},
      createdAt: row.createdAt,
    })),
    nextCursor:
      hasMore && last
        ? { createdAt: last.createdAt.toISOString(), id: last.id }
        : null,
  };
}
