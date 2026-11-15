import { TanStackDevtools } from "@tanstack/react-devtools";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Link,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useLayoutEffect } from "react";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";
import { Button, buttonVariants } from "#/components/ui/button";
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
  errorComponent: () => (
    <RouteNotice
      title="We couldn’t open this page"
      description="Check your connection and try again. If you followed a shared link, make sure you’re signed in with an account that has access."
      retry={() => window.location.reload()}
    />
  ),
  notFoundComponent: () => (
    <RouteNotice
      title="This page isn’t here"
      description="The link may have changed, or this content is no longer available."
    />
  ),
  shellComponent: RootDocument,
});

function RootDocument() {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className="caret-foreground **:border-border **:outline-ring/50 [scrollbar-color:var(--border)_var(--background)] font-sans selection:bg-(--selection) selection:text-(--selection-foreground) [&_[data-slot=input]]:text-(--input-foreground) [&_[data-slot=input]]:placeholder:text-(--input-placeholder) [&_[data-slot=textarea]]:text-(--input-foreground) [&_[data-slot=textarea]]:placeholder:text-(--input-placeholder) [&_select]:text-(--input-foreground)"
    >
      <head>
        <HeadContent />
      </head>
      <body className="bg-background text-foreground antialiased">
        <BrandThemeReset />
        <TooltipProvider>
          <Outlet />
          <Toaster />
        </TooltipProvider>
        {import.meta.env.DEV && (
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
        )}
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

function RouteNotice({
  title,
  description,
  retry,
}: {
  title: string;
  description: string;
  retry?: () => void;
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <Header />
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-20"
      >
        <h1 className="font-serif text-4xl tracking-tight sm:text-5xl">
          {title}
        </h1>
        <p className="text-muted-foreground mt-6 max-w-lg leading-7">
          {description}
        </p>
        <div className="mt-8 flex gap-3">
          {retry && <Button onClick={retry}>Try again</Button>}
          <Link
            to="/projects"
            className={buttonVariants({ variant: "outline" })}
          >
            Back to projects
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  );
}
