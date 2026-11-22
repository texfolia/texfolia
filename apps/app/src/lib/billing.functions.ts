import { createServerFn } from "@tanstack/react-start";
import { isOrgAdmin } from "@texfolia/auth/roles";
import { z } from "zod";

import { ensureSession } from "./auth.functions";

export const getBilling = createServerFn({ method: "GET" })
  .validator(z.object({ organizationId: z.string().min(1).optional() }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const memberships = await context.db.query.member.findMany({
      where: { userId: session.user.id },
      with: { organization: { columns: { id: true, name: true } } },
    });
    const organizations = memberships.flatMap((m) =>
      m.organization ? [m.organization] : [],
    );
    if (
      data.organizationId &&
      !organizations.some((org) => org.id === data.organizationId)
    ) {
      throw new Error("Organization not found");
    }
    const selected = data.organizationId
      ? await context.db.query.organization.findFirst({
          where: { id: data.organizationId },
          columns: { id: true, name: true },
          with: {
            members: {
              columns: { id: true, userId: true, role: true },
              with: { user: { columns: { email: true } } },
            },
            invitations: { columns: { id: true, email: true, status: true } },
          },
        })
      : null;
    const membership = selected?.members.find(
      (m) => m.userId === session.user.id,
    );
    const canManage =
      !selected || (!!membership && isOrgAdmin(membership.role));
    const subscriptions = canManage
      ? await context.db.query.subscription.findMany({
          where: {
            referenceId: selected?.id ?? session.user.id,
            stripeSubscriptionId: { isNotNull: true },
            status: {
              in: [
                "active",
                "trialing",
                "past_due",
                "unpaid",
                "incomplete",
                "paused",
              ],
            },
          },
          orderBy: { periodEnd: "desc" },
        })
      : [];
    return {
      organizations: organizations.map(({ id, name }) => ({ id, name })),
      selected: selected
        ? {
            id: selected.id,
            name: selected.name,
            members: selected.members.flatMap((m) =>
              m.user ? [{ ...m, user: m.user }] : [],
            ),
            invitations: selected.invitations,
          }
        : null,
      canManage,
      subscriptions: subscriptions.map(
        ({ plan, status, periodEnd, cancelAtPeriodEnd }) => ({
          plan,
          status,
          periodEnd,
          cancelAtPeriodEnd,
        }),
      ),
      userId: session.user.id,
    };
  });
