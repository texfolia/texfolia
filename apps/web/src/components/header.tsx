import { ClientOnly, Link } from "@tanstack/react-router";

import { NavigationShortcuts } from "#/components/navigation-shortcuts";
import { Button, buttonVariants } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { authClient } from "#/lib/auth-client";

export function Header() {
  const { data: session } = authClient.useSession();
  return (
    <header className="bg-background border-b">
      <ClientOnly>
        {session && (
          <NavigationShortcuts key={session.user.id} userId={session.user.id} />
        )}
      </ClientOnly>
      <a
        href="#main-content"
        className="bg-background sr-only z-50 p-3 focus:not-sr-only focus:absolute"
      >
        Skip to content
      </a>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-5 py-4 sm:h-20 sm:flex-nowrap sm:gap-10 sm:px-8 sm:py-0">
        <Link
          to="/"
          className="mr-auto font-serif text-3xl tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          Texfolia
          <span aria-hidden="true" className="text-muted-foreground">
            .
          </span>
        </Link>
        <nav
          aria-label="Main navigation"
          className="order-last flex w-full items-center justify-center gap-8 text-sm sm:order-0 sm:w-auto"
        >
          <Link
            to="/templates"
            search={{ page: 0 }}
            className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            Templates
          </Link>
          {session && (
            <Link
              to="/settings/billing"
              className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              Billing
            </Link>
          )}
          <Link
            to="/pricing"
            className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            Pricing
          </Link>
        </nav>
        {session && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" />}>
              {session.user.name}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<Link to="/settings/account" />}>
                Account
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/settings/preferences" />}>
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/settings/billing" />}>
                Billing
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Link
          to={session ? "/projects" : "/login"}
          className={buttonVariants({ size: "lg" })}
        >
          {session ? "Projects" : "Sign in"}
        </Link>
      </div>
    </header>
  );
}
