import type { EmailMessage } from "./send";

const codePurposes = {
  "sign-in": "sign-in",
  "email-verification": "email verification",
  "forget-password": "password reset",
  "change-email": "email change",
};
export type EmailCodeType = keyof typeof codePurposes;

export type ProjectCollaboratorEmailRole = "viewer" | "editor";
export type ProjectShareLinkEmailScope = "project" | "pdf";

const shareLinkScopeAccess: Record<ProjectShareLinkEmailScope, string> = {
  project: "view its sources and PDF",
  pdf: "view its PDF",
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
  return {
    to,
    subject: `You're invited to join ${organization} on Texfolia`,
    text: `You've been invited to join ${organization} on Texfolia. Sign in with this email address to review the invitation: ${url.href}`,
    html: `<p>You've been invited to join an organization on Texfolia.</p><p>Sign in with this email address to <a href="${url.href}">review the invitation</a>.</p>`,
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
  role: ProjectCollaboratorEmailRole;
  url: URL;
}): EmailMessage {
  const access = role === "editor" ? "edit" : "view";
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
  scope,
  url,
}: {
  to: string;
  projectName: string;
  senderName: string;
  scope: ProjectShareLinkEmailScope;
  url: URL;
}): EmailMessage {
  const access = shareLinkScopeAccess[scope];
  const safeSenderSubject = cleanSubjectText(senderName);
  const safeProjectSubject = cleanSubjectText(projectName);
  const safeSender = escapeHtml(senderName);
  const safeProject = escapeHtml(projectName);
  const safeUrl = escapeHtml(url.href);
  return {
    to,
    subject: `${safeSenderSubject} shared ${safeProjectSubject} on Texfolia`,
    text: `${senderName} shared a read-only link to "${projectName}" on Texfolia so you can ${access} without signing in: ${url.href}`,
    html: `<p>${safeSender} shared a read-only link to <strong>${safeProject}</strong> on Texfolia so you can ${access} without signing in.</p><p><a href="${safeUrl}">Open shared link</a></p>`,
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
    html: `<p>Confirm deletion of your Texfolia account and personal projects:</p><p><a href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Delete my account</a></p><p>If you did not request this, ignore this email.</p>`,
  };
}
