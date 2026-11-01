import { createFileRoute, Link } from "@tanstack/react-router";
import { cn } from "cn";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";
import { buttonVariants } from "#/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      {
        title: "Where great minds work together - Texfolia",
      },
    ],
  }),
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div>
      <Header />
      <main>
        <section className="mx-auto flex min-h-[50vh] max-w-7xl items-center justify-between">
          <h1 className="font-serif text-7xl tracking-tighter">
            Where great minds
            <br />
            work together
          </h1>
          <div className="flex flex-col">
            <p className="mt-4 text-lg">
              Texfolia is a collaborative platform that brings humans and agents
              together.
            </p>
            <div className="flex gap-2">
              <Link
                to="/auth"
                className={cn(
                  buttonVariants(),
                  "rounded-full px-6 py-6 text-lg",
                )}
              >
                Get started for free
              </Link>
              <Link
                to="/pricing"
                className={cn(
                  buttonVariants({ variant: "outline" }),
                  "rounded-full px-6 py-6 text-lg",
                )}
              >
                See pricing
              </Link>
            </div>
          </div>
        </section>
        <div className="bg-muted mx-auto h-svh w-7xl"></div>
      </main>
      <Footer />
    </div>
  );
}
