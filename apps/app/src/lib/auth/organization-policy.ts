import {
  APIError,
  type createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import type { Member, Organization } from "better-auth/plugins/organization";
import {
  defaultAc,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";
import { z } from "zod";

import { hasRenewingSubscription } from "#/lib/billing/stripe";

import { hasOrgRole } from "./roles";

type AuthContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * Roles decide who manages an organization, including its teams. Owners and
 * admins can edit every organization project; what members can do depends on
 * each project's sharing (see `lockProject`).
 * Unlike Better Auth's own admins, ours cannot change roles: Better Auth ties
 * team membership to `member: ["update"]`, which also allows role changes, so
 * `assertOrganizationPolicy` keeps those to owners. Removing an admin and
 * inviting one depend on the other person, so it checks those too.
 */
export const organizationRoles = {
  owner: ownerAc,
  admin: defaultAc.newRole({
    organization: ["update"],
    invitation: ["create", "cancel"],
    member: ["create", "update", "delete"],
    team: ["create", "update", "delete"],
  }),
  member: memberAc,
};

export const maxTeamsPerOrganization = 100;

async function findMember(
  ctx: AuthContext,
  organizationId: string,
  userId: string,
) {
  return ctx.context.adapter.findOne<Member>({
    model: "member",
    where: [
      { field: "organizationId", value: organizationId },
      { field: "userId", value: userId },
    ],
  });
}

async function hasOtherOwner(
  ctx: AuthContext,
  organizationId: string,
  userId: string,
) {
  const candidates = await ctx.context.adapter.findMany<Member>({
    model: "member",
    where: [
      { field: "organizationId", value: organizationId },
      { field: "userId", operator: "ne", value: userId },
      { field: "role", operator: "contains", value: "owner" },
    ],
    limit: 10,
  });
  return candidates.some(isOwner);
}

function isOwner(member: Pick<Member, "role"> | undefined | null) {
  return !!member && hasOrgRole(member.role, "owner");
}

const inviteSchema = z.object({
  role: z.union([z.string(), z.array(z.string())]),
  organizationId: z.string().optional(),
});
const removeSchema = z.object({
  memberIdOrEmail: z.string(),
  organizationId: z.string().optional(),
});

/**
 * Only owners may change roles, or invite or remove people who manage the
 * organization.
 */
export async function assertOrganizationPolicy(ctx: AuthContext) {
  if (ctx.path === "/organization/update-member-role") {
    await assertOwner(ctx);
    return;
  }
  const inviting = ctx.path === "/organization/invite-member";
  if (!inviting && ctx.path !== "/organization/remove-member") return;
  // The endpoint rejects bodies and sessions that this cannot use.
  const body = (inviting ? inviteSchema : removeSchema).safeParse(ctx.body);
  if (!body.success) return;
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
  if (!session) return;
  const organizationId =
    body.data.organizationId ?? session.session.activeOrganizationId;
  if (typeof organizationId !== "string") return;
  const actor = await findMember(ctx, organizationId, session.user.id);
  if (!actor || isOwner(actor)) return;
  if ("role" in body.data) {
    const roles = [body.data.role].flat().flatMap((role) => role.split(","));
    if (roles.some((role) => role.trim() !== "member"))
      throw new APIError("FORBIDDEN", {
        message: "Only an organization owner can invite owners and admins.",
      });
    return;
  }
  const { memberIdOrEmail } = body.data;
  let target: Member | null;
  if (memberIdOrEmail.includes("@")) {
    const found =
      await ctx.context.internalAdapter.findUserByEmail(memberIdOrEmail);
    target = found
      ? await findMember(ctx, organizationId, found.user.id)
      : null;
  } else {
    target = await ctx.context.adapter.findOne<Member>({
      model: "member",
      where: [
        { field: "organizationId", value: organizationId },
        { field: "id", value: memberIdOrEmail },
      ],
    });
  }
  // Admins may still remove themselves.
  if (target && target.id !== actor.id && !isPlainMember(target))
    throw new APIError("FORBIDDEN", {
      message: "Only an organization owner can remove owners and admins.",
    });
}

function isPlainMember(member: Pick<Member, "role">) {
  return !hasOrgRole(member.role, "owner", "admin");
}

/** The organizations that would have no owner without this user. */
async function solelyOwned(ctx: AuthContext, userId: string) {
  const owned = (
    await ctx.context.adapter.findMany<Member>({
      model: "member",
      where: [
        { field: "userId", value: userId },
        { field: "role", operator: "contains", value: "owner" },
      ],
    })
  ).filter(isOwner);
  const organizations: Organization[] = [];
  for (const { organizationId } of owned) {
    if (await hasOtherOwner(ctx, organizationId, userId)) continue;
    const organization = await ctx.context.adapter.findOne<Organization>({
      model: "organization",
      where: [{ field: "id", value: organizationId }],
    });
    if (organization) organizations.push(organization);
  }
  return organizations;
}

/** Why the account cannot be deleted now, or null. */
async function deletionBlock(
  ctx: AuthContext,
  user: { id: string; stripeCustomerId?: unknown },
) {
  const organizations = await solelyOwned(ctx, user.id);
  if (organizations.length)
    return {
      reason: "blocked",
      code: "SOLE_ORGANIZATION_OWNER",
      message: `You are the only owner of ${organizations.map(({ name }) => name).join(", ")}. Make someone else an owner, or delete the organization, before deleting your account.`,
    };
  const stripeClient = ctx.context.getPlugin("stripe")?.options.stripeClient;
  if (!stripeClient || typeof user.stripeCustomerId !== "string") return null;
  try {
    if (!(await hasRenewingSubscription(stripeClient, user.stripeCustomerId)))
      return null;
  } catch (error) {
    ctx.context.logger.error("Subscriptions could not be checked", error);
    return {
      reason: "unchecked",
      code: "SUBSCRIPTION_CHECK_FAILED",
      message: "Your subscription could not be checked. Try again later.",
    };
  }
  return {
    reason: "subscribed",
    code: "ACTIVE_SUBSCRIPTION",
    message:
      "Cancel your subscription in Billing settings before deleting your account.",
  };
}

/**
 * Keeps accounts from leaving an organization without an owner, whom its
 * subscription needs, and from leaving a subscription that nobody can cancel.
 */
export async function assertAccountDeletable(ctx: AuthContext) {
  const confirming = ctx.path === "/delete-user/callback";
  if (!confirming && ctx.path !== "/delete-user") return;
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
  if (!session) return;
  const block = await deletionBlock(ctx, session.user);
  if (!block) return;
  const { reason, code, message } = block;
  // The link in the confirmation email opens in the browser.
  if (confirming) throw ctx.redirect(`/settings/account?deletion=${reason}`);
  throw new APIError(
    reason === "unchecked" ? "SERVICE_UNAVAILABLE" : "BAD_REQUEST",
    { code, message },
  );
}

/**
 * Updates the paid seats after a member left by a route that Better Auth does
 * not report to its Stripe plugin.
 */
export async function syncSeats(
  ctx: AuthContext,
  user: { id: string },
  organizationIds: readonly string[],
) {
  const plugin = ctx.context.getPlugin("organization");
  const hooks = plugin?.options?.organizationHooks;
  for (const id of organizationIds) {
    const organization = await ctx.context.adapter.findOne<Organization>({
      model: "organization",
      where: [{ field: "id", value: id }],
    });
    if (organization)
      await hooks?.afterRemoveMember?.({
        member: { userId: user.id, organizationId: id },
        user,
        organization,
      } as Parameters<NonNullable<typeof hooks.afterRemoveMember>>[0]);
  }
}

/** The organizations this user belongs to. */
export async function memberOrganizations(ctx: AuthContext, userId: string) {
  const members = await ctx.context.adapter.findMany<Member>({
    model: "member",
    where: [{ field: "userId", value: userId }],
  });
  return members.map(({ organizationId }) => organizationId);
}

const organizationBodySchema = z.object({
  organizationId: z.string().optional(),
});

async function assertOwner(ctx: AuthContext) {
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
  if (!session) return;
  const body = organizationBodySchema.safeParse(ctx.body);
  const organizationId =
    (body.success ? body.data.organizationId : undefined) ??
    session.session.activeOrganizationId;
  if (typeof organizationId !== "string") return;
  const actor = await findMember(ctx, organizationId, session.user.id);
  // The endpoint rejects people who are not members.
  if (actor && !isOwner(actor))
    throw new APIError("FORBIDDEN", {
      message: "Only an organization owner can change roles.",
    });
}
