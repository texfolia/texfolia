import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";

export function PolicyTemplate({
  title,
  sections,
}: {
  title: string;
  sections: readonly { id: string; title: string; content: ReactNode }[];
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <Header />
      <main
        id="main-content"
        className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-24"
      >
        <h1 className="font-serif text-5xl tracking-tight text-balance sm:text-6xl">
          {title}
        </h1>
        <aside
          aria-labelledby="policy-template-notice"
          className="bg-muted mt-8 space-y-3 border p-5 sm:p-6"
        >
          <h2 id="policy-template-notice" className="text-lg font-semibold">
            Placeholder for review
          </h2>
          <p className="max-w-prose leading-7">
            This page is an unapproved template, not a final release policy.
            Product descriptions are draft copy. Sections marked "To be
            completed" still need final wording and approval.
          </p>
          <p className="text-sm font-medium">Effective date: Not set</p>
        </aside>
        <nav aria-label="On this page" className="mt-10">
          <h2 className="text-sm font-semibold">On this page</h2>
          <ul className="mt-3 grid gap-x-8 sm:grid-cols-2">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="inline-block py-2 text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mt-10 space-y-10">
          {sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-heading`}
              className="scroll-mt-8 border-t pt-8"
            >
              <h2
                id={`${section.id}-heading`}
                className="text-xl font-semibold text-balance"
              >
                {section.title}
              </h2>
              <div className="mt-4 max-w-prose space-y-4 leading-7 [&_a]:underline [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-4">
                {section.content}
              </div>
            </section>
          ))}
        </div>
        <nav
          aria-label="Policy pages"
          className="mt-12 flex flex-wrap gap-x-6 gap-y-4 border-t pt-8 text-sm [&_a]:underline [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-4"
        >
          <Link to="/privacy" activeProps={{ "aria-current": "page" }}>
            Privacy policy
          </Link>
          <Link to="/terms" activeProps={{ "aria-current": "page" }}>
            Terms of service
          </Link>
          <Link to="/pricing">Plans and pricing</Link>
        </nav>
      </main>
      <Footer />
    </div>
  );
}

export function PolicyPlaceholder({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground text-sm leading-6">
      <span className="text-foreground font-medium">To be completed.</span>{" "}
      {children}
    </p>
  );
}
