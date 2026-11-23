import { Link } from "@tanstack/react-router";

import { linkButton } from "#/lib/link-button";
import { appPath } from "#/lib/urls";

const navLink =
  "text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4";

export function Header() {
  return (
    <header className="bg-background border-b">
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
          <Link to="/templates" className={navLink}>
            Templates
          </Link>
          <Link to="/pricing" className={navLink}>
            Pricing
          </Link>
        </nav>
        <a
          href={appPath("/login")}
          className={linkButton({ variant: "outline" })}
        >
          Sign in
        </a>
        <a href={appPath("/projects")} className={linkButton({ size: "lg" })}>
          Open app
        </a>
      </div>
    </header>
  );
}
