import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { ensureSession } from "./auth.functions";

export const getBilling = createServerFn({ method: "GET" })
  .validator(z.object({ organizationId: z.string().min(1).optional() }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    // Loaded on demand so the Stripe SDK stays out of the client bundle.
    const { billingOverview } = await import("@texfolia/billing/server");
    return billingOverview(context.db, {
      userId: session.user.id,
      organizationId: data.organizationId,
    });
  });
