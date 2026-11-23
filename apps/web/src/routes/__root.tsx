import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";
import { linkButton } from "#/lib/link-button";

import css from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Texfolia" },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
  }),
  notFoundComponent: () => (
    <Notice
      title="This page isn’t here"
      description="The link may have changed, or this page is no longer available."
    />
  ),
  errorComponent: () => (
    <Notice
      title="We couldn’t open this page"
      description="Check your connection and try again."
    />
  ),
  shellComponent: RootDocument,
  component: Outlet,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-svh antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Notice({
  title,
  description,
}: {
  title: string;
  description: string;
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
        <div className="mt-8">
          <Link to="/" className={linkButton({ variant: "outline" })}>
            Back to home
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  );
}
