import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { getSession } from "#/lib/auth.functions";

export const Route = createFileRoute("/projects")({
  beforeLoad: async ({ location }) => {
    const session = await getSession();

    if (!session) {
      throw redirect({
        to: "/login",
        search: { redirectTo: location.href },
      });
    }

    return { user: session.user };
  },
  component: () => <Outlet />,
});
