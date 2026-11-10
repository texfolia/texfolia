import { TanStackDevtools } from "@tanstack/react-devtools";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useLayoutEffect } from "react";

import { Toaster } from "#/components/ui/toast";
import { TooltipProvider } from "#/components/ui/tooltip";
import { getSession } from "#/lib/auth.functions";
import {
  clearAppTheme,
  isAppPath,
  themeBootstrap,
} from "#/lib/theme-bootstrap";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => ({
    appUser: isAppPath(location.pathname)
      ? ((await getSession())?.user ?? null)
      : null,
  }),
  head: ({ match }) => ({
    scripts: match.context.appUser
      ? [{ children: themeBootstrap(match.context.appUser.id) }]
      : [],
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Texfolia",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <BrandThemeReset />
        <TooltipProvider>
          <Outlet />
          <Toaster />
        </TooltipProvider>
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}

function BrandThemeReset() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  useLayoutEffect(() => {
    if (!isAppPath(pathname)) clearAppTheme(document.documentElement);
  }, [pathname]);
  return null;
}
