import { createFileRoute } from "@tanstack/react-router";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms of service | Texfolia" }] }),
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
          Terms of service
        </h1>
        <p className="text-muted-foreground mt-8 text-sm leading-6">
          The complete release terms are being finalized. The current
          compilation fair-use policy is below.
        </p>
        <section className="mt-10 space-y-4 border-t pt-8 leading-7">
          <h2 className="text-xl font-semibold">Fair use</h2>
          <p>
            Fair use applies to compilation on all plans. Compile timeouts and
            request rate limits depend on your plan. To keep Texfolia fast and
            available for everyone, sustained heavy compilation may be
            temporarily slowed or paused. You can try again after a short wait;
            access recovers automatically as recent activity decreases.
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
