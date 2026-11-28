import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { ensureSession } from "#/lib/auth/auth.functions";

import { organizationAuditCategories } from "./audit";

const getOrganizationAuditLogSchema = z.object({
  organizationId: z.string().min(1),
  category: z.enum(organizationAuditCategories).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z
    .object({
      createdAt: z.string().min(1),
      id: z.string().uuid(),
    })
    .optional(),
});

/**
 * Read-only server function for the organization audit log.
 * Access control (owner/admin only) is enforced in `listOrganizationAuditEvents`.
 */
export const getOrganizationAuditLog = createServerFn({ method: "GET" })
  .validator(getOrganizationAuditLogSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const { listOrganizationAuditEvents } = await import("./audit.server");
    return listOrganizationAuditEvents(context.db, {
      userId: session.user.id,
      organizationId: data.organizationId,
      category: data.category,
      limit: data.limit,
      cursor: data.cursor,
    });
  });
