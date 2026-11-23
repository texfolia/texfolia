import type { EmailMessage } from "./send";

const codePurposes = {
  "sign-in": "sign-in",
  "email-verification": "email verification",
  "forget-password": "password reset",
  "change-email": "email change",
};
export type EmailCodeType = keyof typeof codePurposes;

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
