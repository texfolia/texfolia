import type { Db } from "@texfolia/db";

import {
  invalidateOrganizationCollaborationAccess,
  type CollaborationAccess,
} from "#/features/collaboration/server";
import { sendEmail, type EmailMessage } from "#/features/email";

import { createAuth as createBaseAuth, type Auth } from "./server";

export type { Auth };
export { createEmailOTPPlugin, createOrganizationPlugin } from "./server";

// Loaded on first use because only Workers provide the binding module.
async function deliver(message: EmailMessage) {
  const { env } = await import("cloudflare:workers");
  await sendEmail(env.EMAIL, message);
}

export function createAuth(db: Db, collaboration?: CollaborationAccess): Auth {
  return createBaseAuth(db, {
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
