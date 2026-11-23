import { createAuth as createSharedAuth, type Auth } from "@texfolia/auth";
import type { Db } from "@texfolia/db";
import { sendEmail, type EmailMessage } from "@texfolia/email";

import {
  invalidateOrganizationCollaborationAccess,
  type CollaborationAccess,
} from "#/features/collaboration/server";

export type { Auth };
export { createEmailOTPPlugin, createOrganizationPlugin } from "@texfolia/auth";

// Loaded on first use because only Workers provide the binding module.
async function deliver(message: EmailMessage) {
  const { env } = await import("cloudflare:workers");
  await sendEmail(env.EMAIL, message);
}

export function createAuth(db: Db, collaboration?: CollaborationAccess): Auth {
  return createSharedAuth(db, {
    sendEmail: deliver,
    onMemberRemoved: async (member) => {
      await invalidateOrganizationCollaborationAccess({
        db,
        collaboration,
        ...member,
      });
    },
  });
}
