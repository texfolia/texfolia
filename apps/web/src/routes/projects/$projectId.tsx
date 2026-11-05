import { createFileRoute } from "@tanstack/react-router";

import { ProjectWorkspace } from "#/components/project-workspace";
import { getProject } from "#/lib/projects.functions";

export const Route = createFileRoute("/projects/$projectId")({
  loader: ({ params }) => getProject({ data: { projectId: params.projectId } }),
  component: RouteComponent,
});

function RouteComponent() {
  const project = Route.useLoaderData();
  return (
    <ProjectWorkspace
      key={project.id}
      projectId={project.id}
      name={project.name}
      nodes={project.nodes}
    />
  );
}
