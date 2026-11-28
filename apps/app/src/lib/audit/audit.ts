import type {
  AuditMetadata,
  AuditMetadataValue,
} from "@texfolia/db/schema/audit";

export type { AuditMetadata, AuditMetadataValue };

export const organizationAuditActions = [
  "organization.updated",
  "invitation.created",
  "invitation.accepted",
  "invitation.rejected",
  "invitation.canceled",
  "invitation.expired",
  "member.added",
  "member.role_updated",
  "member.removed",
  "member.left",
  "team.created",
  "team.updated",
  "team.deleted",
  "team.member_added",
  "team.member_removed",
  "billing.subscription_started",
  "billing.subscription_updated",
  "billing.subscription_cancel_scheduled",
  "billing.subscription_canceled",
  "billing.seats_updated",
  "billing.payment_failed",
  "billing.ai_cap_updated",
  "project.share_link_created",
  "project.share_link_revoked",
  "project.organization_role_updated",
  "project.collaborator_granted",
  "project.collaborator_updated",
  "project.collaborator_revoked",
  "project.team_access_granted",
  "project.team_access_updated",
  "project.team_access_revoked",
] as const;

export type OrganizationAuditAction = (typeof organizationAuditActions)[number];

export const organizationAuditCategories = [
  "all",
  "invitations",
  "members",
  "teams",
  "billing",
  "sharing",
  "organization",
] as const;

export type OrganizationAuditCategory =
  (typeof organizationAuditCategories)[number];

export const organizationAuditCategoryLabels: Record<
  OrganizationAuditCategory,
  string
> = {
  all: "All events",
  invitations: "Invitations",
  members: "Members",
  teams: "Teams",
  billing: "Billing",
  sharing: "Project sharing",
  organization: "Organization",
};

export const organizationAuditCategoryPrefixes: Record<
  Exclude<OrganizationAuditCategory, "all">,
  string
> = {
  invitations: "invitation.",
  members: "member.",
  teams: "team.",
  billing: "billing.",
  sharing: "project.",
  organization: "organization.",
};

export type OrganizationAuditEventRecord = {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  actor: { id: string; name: string; email: string } | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: AuditMetadata;
  createdAt: Date | string;
};

/**
 * Keys that must never be persisted in audit metadata (case-insensitive
 * substring match). Stripe resource IDs such as `stripeSubscriptionId` and
 * `stripeCustomerId` are explicitly allowed; secrets, tokens, passwords, and
 * raw share links are stripped.
 */
const forbiddenKeyPatterns = [
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "privatekey",
  "private_key",
  "signature",
  "credential",
  "backupcode",
  "backup_code",
  "otp",
];

/**
 * String values that look like secrets, bearer tokens, Stripe keys/webhook
 * secrets, or share URLs containing raw tokens.
 */
const forbiddenValuePatterns = [
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/,
  /^whsec_[A-Za-z0-9]+/,
  /^bearer\s+\S+/i,
  /\/share\/[A-Za-z0-9_-]{12,}/,
];

function isForbiddenKey(key: string) {
  const normalized = key.toLowerCase();
  return forbiddenKeyPatterns.some((pattern) => normalized.includes(pattern));
}

function isForbiddenValue(value: string) {
  return forbiddenValuePatterns.some((pattern) => pattern.test(value.trim()));
}

function sanitizeValue(
  value: unknown,
  depth: number,
): AuditMetadataValue | undefined {
  if (depth > 4) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (isForbiddenValue(value)) return undefined;
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const cleaned: AuditMetadataValue[] = [];
    for (const item of value.slice(0, 50)) {
      const next = sanitizeValue(item, depth + 1);
      if (next !== undefined) cleaned.push(next);
    }
    return cleaned;
  }
  if (typeof value === "object") {
    const out: AuditMetadata = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isForbiddenKey(key)) continue;
      const cleaned = sanitizeValue(entry, depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined;
}

/**
 * Removes secrets, tokens, passwords, and raw share URLs from audit metadata
 * before persistence.
 */
export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): AuditMetadata {
  if (!metadata) return {};
  const result = sanitizeValue(metadata, 0);
  return result && typeof result === "object" && !Array.isArray(result)
    ? result
    : {};
}

function str(metadata: AuditMetadata, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(metadata: AuditMetadata, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Human-readable summary of an audit event for the organization settings UI. */
export function describeAuditEvent(
  event: Pick<
    OrganizationAuditEventRecord,
    "action" | "targetType" | "targetId" | "metadata"
  >,
): { summary: string; detail: string | null } {
  const m = event.metadata;
  const email = str(m, "email") ?? str(m, "targetEmail");
  const role = str(m, "role");
  const previousRole = str(m, "previousRole");
  const teamName = str(m, "teamName");
  const projectName = str(m, "projectName");
  const plan = str(m, "plan");
  const seats = num(m, "seats");

  switch (event.action) {
    case "organization.updated":
      return {
        summary: str(m, "name")
          ? `Renamed organization to ${str(m, "name")}`
          : "Updated organization settings",
        detail: null,
      };
    case "invitation.created":
      return {
        summary: email
          ? `Invited ${email}${role ? ` as ${role}` : ""}`
          : "Sent an invitation",
        detail: null,
      };
    case "invitation.accepted":
      return {
        summary: email
          ? `Accepted invitation for ${email}${role ? ` (${role})` : ""}`
          : "Accepted an invitation",
        detail: null,
      };
    case "invitation.rejected":
      return {
        summary: email
          ? `Declined invitation for ${email}`
          : "Declined an invitation",
        detail: null,
      };
    case "invitation.canceled":
      return {
        summary: email
          ? `Canceled invitation for ${email}`
          : "Canceled an invitation",
        detail: null,
      };
    case "invitation.expired":
      return {
        summary: email
          ? `Invitation expired for ${email}`
          : "Invitation expired",
        detail: role ? `Invited role: ${role}` : null,
      };
    case "member.added":
      return {
        summary: email
          ? `Added ${email}${role ? ` as ${role}` : ""}`
          : "Added a member",
        detail: null,
      };
    case "member.role_updated":
      return {
        summary: email
          ? `Changed role for ${email}`
          : "Changed a member's role",
        detail:
          previousRole && role
            ? `${previousRole} → ${role}`
            : role
              ? `Role: ${role}`
              : null,
      };
    case "member.removed":
      return {
        summary: email ? `Removed ${email}` : "Removed a member",
        detail: role ? `Former role: ${role}` : null,
      };
    case "member.left":
      return {
        summary: email
          ? `${email} left the organization`
          : "Left the organization",
        detail: role ? `Former role: ${role}` : null,
      };
    case "team.created":
      return {
        summary: teamName ? `Created team ${teamName}` : "Created a team",
        detail: null,
      };
    case "team.updated":
      return {
        summary: teamName ? `Updated team ${teamName}` : "Updated a team",
        detail: null,
      };
    case "team.deleted":
      return {
        summary: teamName ? `Deleted team ${teamName}` : "Deleted a team",
        detail: null,
      };
    case "team.member_added":
      return {
        summary:
          email && teamName
            ? `Added ${email} to ${teamName}`
            : teamName
              ? `Added a member to ${teamName}`
              : "Added a member to a team",
        detail: null,
      };
    case "team.member_removed":
      return {
        summary:
          email && teamName
            ? `Removed ${email} from ${teamName}`
            : teamName
              ? `Removed a member from ${teamName}`
              : "Removed a member from a team",
        detail: null,
      };
    case "billing.subscription_started":
      return {
        summary: plan ? `Started ${plan} subscription` : "Started subscription",
        detail:
          seats !== null ? `${seats} seat${seats === 1 ? "" : "s"}` : null,
      };
    case "billing.seats_updated":
      return {
        summary:
          seats !== null
            ? `Updated subscription seats to ${seats}`
            : "Updated subscription seats",
        detail: plan ? `Plan: ${plan}` : null,
      };
    case "billing.subscription_updated":
      return {
        summary: plan ? `Updated ${plan} subscription` : "Updated subscription",
        detail: str(m, "status") ? `Status: ${str(m, "status")}` : null,
      };
    case "billing.subscription_cancel_scheduled":
      return {
        summary: "Scheduled subscription cancellation",
        detail: plan ? `Plan: ${plan}` : null,
      };
    case "billing.subscription_canceled":
      return {
        summary: "Subscription ended",
        detail: plan ? `Plan: ${plan}` : null,
      };
    case "billing.payment_failed": {
      const amountDue = num(m, "amountDue");
      const currency = str(m, "currency");
      const detail =
        amountDue !== null && currency
          ? `${(amountDue / 100).toFixed(2)} ${currency.toUpperCase()}`
          : null;
      return {
        summary: "Subscription payment failed",
        detail,
      };
    }
    case "billing.ai_cap_updated": {
      const dollars = num(m, "monthlyCapDollars");
      return {
        summary:
          dollars !== null
            ? `Updated monthly AI spend cap to $${dollars.toFixed(2)}`
            : "Updated monthly AI spend cap",
        detail: null,
      };
    }
    case "project.share_link_created":
      return {
        summary: projectName
          ? `Created ${role ?? ""} share link on ${projectName}`.replace(
              /\s+/g,
              " ",
            )
          : "Created a project share link",
        detail: m.emailedRecipient === true ? "Sent link by email" : null,
      };
    case "project.share_link_revoked":
      return {
        summary: projectName
          ? `Revoked ${role ?? ""} share link on ${projectName}`.replace(
              /\s+/g,
              " ",
            )
          : "Revoked a project share link",
        detail: null,
      };
    case "project.organization_role_updated":
      return {
        summary: projectName
          ? `Updated organization access on ${projectName}`
          : "Updated organization project access",
        detail: `${previousRole ?? "none"} → ${role ?? "none"}`,
      };
    case "project.collaborator_granted":
      return {
        summary:
          email && projectName
            ? `Granted ${email} ${role ?? ""} access to ${projectName}`.replace(
                /\s+/g,
                " ",
              )
            : "Granted collaborator access on a project",
        detail: null,
      };
    case "project.collaborator_updated":
      return {
        summary:
          email && projectName
            ? `Updated ${email}'s access on ${projectName}`
            : "Updated collaborator access on a project",
        detail: previousRole && role ? `${previousRole} → ${role}` : null,
      };
    case "project.collaborator_revoked":
      return {
        summary: projectName
          ? `Revoked collaborator access on ${projectName}`
          : "Revoked collaborator access on a project",
        detail: previousRole ? `Former role: ${previousRole}` : null,
      };
    case "project.team_access_granted":
      return {
        summary:
          teamName && projectName
            ? `Granted team ${teamName} ${role ?? ""} access to ${projectName}`.replace(
                /\s+/g,
                " ",
              )
            : "Granted team access on a project",
        detail: null,
      };
    case "project.team_access_updated":
      return {
        summary:
          teamName && projectName
            ? `Updated team ${teamName}'s access on ${projectName}`
            : "Updated team access on a project",
        detail: previousRole && role ? `${previousRole} → ${role}` : null,
      };
    case "project.team_access_revoked":
      return {
        summary: projectName
          ? `Revoked team access on ${projectName}`
          : "Revoked team access on a project",
        detail: previousRole ? `Former role: ${previousRole}` : null,
      };
    default:
      return {
        summary: event.action,
        detail: event.targetId
          ? `${event.targetType}: ${event.targetId}`
          : null,
      };
  }
}
