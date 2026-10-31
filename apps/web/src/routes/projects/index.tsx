import { createFileRoute } from "@tanstack/react-router";

import { getProjects } from "#/lib/projects.functions";

export const Route = createFileRoute("/projects/")({
  head: () => ({
    meta: [
      {
        title: "Your Projects | Texfolia",
      },
    ],
  }),
  loader: async () => {
    return { projects: await getProjects() };
  },
  component: RouteComponent,
});

function RouteComponent() {
  return <div>Hello "/projects/"!</div>;
}
