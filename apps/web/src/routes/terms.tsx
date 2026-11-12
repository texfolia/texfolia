import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-semibold">Terms of service</h1>
      <section className="mt-8 space-y-4">
        <h2 className="text-xl font-semibold">Fair use</h2>
        <p>
          Fair use applies to compilation on all plans. Compile timeouts and
          request rate limits depend on your plan. To keep Texfolia fast and
          available for everyone, sustained heavy compilation may be temporarily
          slowed or paused. You can try again after a short wait; access
          recovers automatically as recent activity decreases.
        </p>
      </section>
    </main>
  );
}
