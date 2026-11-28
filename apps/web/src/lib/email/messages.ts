import type { EmailMessage } from "./send";

const codePurposes = {
  "sign-in": "sign-in",
  "email-verification": "email verification",
  "forget-password": "password reset",
  "change-email": "email change",
};
export type EmailCodeType = keyof typeof codePurposes;

export type ProjectEmailRole = "viewer" | "commenter" | "editor";

const roleAccess: Record<ProjectEmailRole, string> = {
  viewer: "view",
  commenter: "comment on",
  editor: "edit",
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cleanSubjectText(value: string) {
  return value.replaceAll(/[\r\n]+/g, " ").trim();
}

export function codeEmail({
  to,
  code,
  type,
}: {
  to: string;
  code: string;
  type: EmailCodeType;
}): EmailMessage {
  const purpose = codePurposes[type];
  return {
    to,
    subject: `Your Texfolia ${purpose} code`,
    text: `Your Texfolia ${purpose} code is ${code}. It expires in 5 minutes. If you did not request this code, you can ignore this email.`,
    html: `<p>Your Texfolia ${purpose} code is:</p><p><strong>${code}</strong></p><p>It expires in 5 minutes. If you did not request this code, you can ignore this email.</p>`,
  };
}

export function invitationEmail({
  to,
  organization,
  url,
}: {
  to: string;
  organization: string;
  url: URL;
}): EmailMessage {
  const organizationName = cleanSubjectText(organization);
  const safeOrganization = escapeHtml(organizationName);
  const safeUrl = escapeHtml(url.href);
  return {
    to,
    subject: `You're invited to join ${organizationName} on Texfolia`,
    text: `You've been invited to join ${organizationName} on Texfolia. Sign in with this email address to review the invitation: ${url.href}`,
    html: `<p>You've been invited to join <strong>${safeOrganization}</strong> on Texfolia.</p><p>Sign in with this email address to <a href="${safeUrl}">review the invitation</a>.</p>`,
  };
}

export function projectCollaboratorEmail({
  to,
  projectName,
  inviterName,
  role,
  url,
}: {
  to: string;
  projectName: string;
  inviterName: string;
  role: ProjectEmailRole;
  url: URL;
}): EmailMessage {
  const access = roleAccess[role];
  const safeProjectSubject = cleanSubjectText(projectName);
  const safeInviter = escapeHtml(inviterName);
  const safeProject = escapeHtml(projectName);
  const safeUrl = escapeHtml(url.href);
  return {
    to,
    subject: `You were added to ${safeProjectSubject} on Texfolia`,
    text: `${inviterName} shared "${projectName}" with you on Texfolia so you can ${access} it. Sign in with this email address to open the project: ${url.href}`,
    html: `<p>${safeInviter} shared <strong>${safeProject}</strong> with you on Texfolia so you can ${access} it.</p><p>Sign in with this email address to <a href="${safeUrl}">open the project</a>.</p>`,
  };
}

export function projectShareLinkEmail({
  to,
  projectName,
  senderName,
  role,
  url,
}: {
  to: string;
  projectName: string;
  senderName: string;
  role: ProjectEmailRole;
  url: URL;
}): EmailMessage {
  const access = roleAccess[role];
  // Anyone can open a view link; comment and edit links need an account.
  const signIn =
    role === "viewer"
      ? "without signing in"
      : "after signing in or creating an account";
  const safeSenderSubject = cleanSubjectText(senderName);
  const safeProjectSubject = cleanSubjectText(projectName);
  const safeSender = escapeHtml(senderName);
  const safeProject = escapeHtml(projectName);
  const safeUrl = escapeHtml(url.href);
  return {
    to,
    subject: `${safeSenderSubject} shared ${safeProjectSubject} on Texfolia`,
    text: `${senderName} shared a link to "${projectName}" on Texfolia so you can ${access} it ${signIn}: ${url.href}`,
    html: `<p>${safeSender} shared a link to <strong>${safeProject}</strong> on Texfolia so you can ${access} it ${signIn}.</p><p><a href="${safeUrl}">Open shared link</a></p>`,
  };
}

export function deleteAccountEmail({
  to,
  url,
}: {
  to: string;
  url: string;
}): EmailMessage {
  return {
    to,
    subject: "Confirm deletion of your Texfolia account",
    text: `Confirm account deletion: ${url}. This permanently deletes your account and personal projects. If you did not request this, ignore this email.`,
    html: `<p>Confirm deletion of your Texfolia account and personal projects:</p><p><a href="${escapeHtml(url)}">Delete my account</a></p><p>If you did not request this, ignore this email.</p>`,
  };
}

export function mentionEmail({
  to,
  actorName,
  projectName,
  surface,
  excerpt,
  url,
}: {
  to: string;
  actorName: string;
  projectName: string;
  surface: "comment" | "scratchpad";
  excerpt: string;
  url: URL;
}): EmailMessage {
  const place =
    surface === "comment" ? "a review comment" : "the project scratchpad";
  const safeActorSubject = cleanSubjectText(actorName);
  const safeProjectSubject = cleanSubjectText(projectName);
  const safeActor = escapeHtml(actorName);
  const safeProject = escapeHtml(projectName);
  const safeExcerpt = escapeHtml(excerpt);
  const safeUrl = escapeHtml(url.href);
  const trimmedExcerpt = excerpt.trim();
  return {
    to,
    subject: `${safeActorSubject} mentioned you in ${safeProjectSubject} on Texfolia`,
    text: trimmedExcerpt
      ? `${actorName} mentioned you in ${place} on "${projectName}":\n\n"${trimmedExcerpt}"\n\nOpen in Texfolia: ${url.href}`
      : `${actorName} mentioned you in ${place} on "${projectName}". Open in Texfolia: ${url.href}`,
    html: trimmedExcerpt
      ? `<p><strong>${safeActor}</strong> mentioned you in ${place} on <strong>${safeProject}</strong>:</p><blockquote>${safeExcerpt}</blockquote><p><a href="${safeUrl}">Open in Texfolia</a></p>`
      : `<p><strong>${safeActor}</strong> mentioned you in ${place} on <strong>${safeProject}</strong>.</p><p><a href="${safeUrl}">Open in Texfolia</a></p>`,
  };
}
