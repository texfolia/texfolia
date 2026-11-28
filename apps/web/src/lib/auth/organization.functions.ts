import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

import { ensureSession } from "./auth.functions";

export const getOrganizations = createServerFn({ method: "GET" })
  .validator(z.object({ organizationId: z.string().min(1).optional() }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const { organizationOverview } = await import("./organization.server");
    return organizationOverview(context.db, {
      userId: session.user.id,
      organizationId: data.organizationId,
    });
  });

export const getOrganizationInvitation = createServerFn({ method: "GET" })
  .validator(z.object({ invitationId: z.string().min(1) }))
  .handler(({ data, context }) =>
    context.auth.api.getInvitation({
      query: { id: data.invitationId },
      headers: getRequestHeaders(),
    }),
  );
