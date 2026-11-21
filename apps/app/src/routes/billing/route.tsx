import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
export const Route = createFileRoute("/billing")({
  validateSearch: z.object({
    plan: z.enum(["pro", "team"]).optional(),
    organizationId: z.string().min(1).optional(),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/billing", search, replace: true });
  },
});
