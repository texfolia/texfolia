import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { getSharedProject } from "#/lib/project-share-links.functions";
import { shareTokenSchema } from "#/lib/project-share-links.schema";
import { ThemeProvider } from "#/providers/theme-provider";

import { SharedProjectView } from "./-components/shared-project-view";

export const Route = createFileRoute("/share/$token")({
  ssr: false,
  loader: async ({ params }) => {
    if (!shareTokenSchema.safeParse(params.token).success) throw notFound();
    const project = await getSharedProject({ data: { token: params.token } });
    if (!project) throw notFound();
    return { project };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.project
          ? `${loaderData.project.name} | Texfolia`
          : "Shared project | Texfolia",
      },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  notFoundComponent: () => (
    <main
      id="main-content"
      className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-4 px-6"
    >
      <h1 className="text-2xl">This link no longer works</h1>
      <p className="text-muted-foreground">
        The owner may have revoked it, or the project was deleted. Ask them for
        a new link.
      </p>
      <Link to="/" className="underline">
        Go to Texfolia
      </Link>
    </main>
  ),
  remountDeps: ({ params }) => params.token,
  component: SharePage,
});

function SharePage() {
  const { project } = Route.useLoaderData();
  const { token } = Route.useParams();
  return (
    // Guests have no account settings; appearance stays in this browser.
    <ThemeProvider userId="share-guest">
      <SharedProjectView project={project} token={token} />
    </ThemeProvider>
  );
}
