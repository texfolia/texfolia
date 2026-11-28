import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { ensureSession } from "#/lib/auth/auth.functions";

import { usagePeriods } from "./usage-analytics";

export const getBilling = createServerFn({ method: "GET" })
  .validator(z.object({ organizationId: z.string().min(1).optional() }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    // Loaded on demand so the Stripe SDK stays out of the client bundle.
    const { billingOverview } = await import("./server");
    return billingOverview(context.db, {
      userId: session.user.id,
      organizationId: data.organizationId,
    });
  });

export const getUsageDashboard = createServerFn({ method: "GET" })
  .validator(
    z.object({
      organizationId: z.string().min(1).optional(),
      period: z.enum(usagePeriods).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const { getUsageDashboard } = await import("./server");
    return getUsageDashboard(context.db, {
      userId: session.user.id,
      organizationId: data.organizationId,
      period: data.period,
    });
  });

export const saveOrganizationCap = createServerFn({ method: "POST" })
  .validator(
    z.object({
      organizationId: z.string().min(1),
      dollars: z.number().finite().min(0).max(10_000).multipleOf(0.01),
    }),
  )
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const { saveOrganizationAiCap } = await import("./server");
    await saveOrganizationAiCap(context.db, {
      userId: session.user.id,
      organizationId: data.organizationId,
      dollars: data.dollars,
    });
  });
