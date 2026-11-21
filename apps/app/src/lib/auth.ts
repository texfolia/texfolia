import {
  createAuth as createSharedAuth,
  type Auth,
} from "@texfolia/auth";
import type { Db } from "@texfolia/db";

import {
  invalidateOrganizationCollaborationAccess,
  type CollaborationAccess,
} from "./collaboration/access.server";

export type { Auth };
export {
  authorizeOrganizationBilling,
  createBillingPlugin,
  createEmailOTPPlugin,
  createOrganizationPlugin,
  enforceBillingScope,
} from "@texfolia/auth";

async function sendEmail(
  options: Parameters<typeof import("./email").sendEmail>[0],
) {
  const { sendEmail } = await import("./email");
  return sendEmail(options);
}

export function createAuth(db: Db, collaboration?: CollaborationAccess): Auth {
  return createSharedAuth(db, {
    sendEmail,
    onMemberRemoved: async (member) => {
      await invalidateOrganizationCollaborationAccess({
        db,
        collaboration,
        ...member,
      });
    },
  });
}
