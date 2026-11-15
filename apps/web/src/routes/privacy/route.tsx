import { createFileRoute } from "@tanstack/react-router";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Privacy | Texfolia" }] }),
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="flex min-h-svh flex-col">
      <Header />
      <main
        id="main-content"
        className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-24"
      >
        <h1 className="font-serif text-5xl tracking-tight sm:text-6xl">
          Privacy
        </h1>
        <section className="mt-10 border-y py-8">
          <h2 className="text-xl font-medium">Privacy notice in preparation</h2>
          <p className="text-muted-foreground mt-4 max-w-prose leading-7">
            Texfolia’s product-specific privacy notice is being finalized before
            release. It will explain how account details, documents,
            collaboration, and service data are handled.
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
