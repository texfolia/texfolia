import { createFileRoute } from "@tanstack/react-router";

import { Header } from "#/components/header";

export const Route = createFileRoute("/")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div>
      <Header />
      <main>
        <h1 className="font-serif text-4xl">
          The intelligent LaTeX platform for everyone
        </h1>
        <p className="mt-4 text-lg">
          Edit <code>src/routes/index.tsx</code> to get started.
        </p>
      </main>
    </div>
  );
}
