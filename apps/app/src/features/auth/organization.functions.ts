import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

export const getOrganizationInvitation = createServerFn({ method: "GET" })
  .validator(z.object({ invitationId: z.string().min(1) }))
  .handler(({ data, context }) =>
    context.auth.api.getInvitation({
      query: { id: data.invitationId },
      headers: getRequestHeaders(),
    }),
  );
