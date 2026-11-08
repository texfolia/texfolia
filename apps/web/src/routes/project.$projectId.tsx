import { createFileRoute, redirect } from "@tanstack/react-router";

import { createProjectFilesStore } from "#/features/projects/collections";
import { getProject } from "#/features/projects/server";
import { ProjectWorkspace } from "#/features/projects/workspace";
import { SettingsProvider } from "#/hooks/use-settings";
import { getSession } from "#/lib/auth.functions";

export const Route = createFileRoute("/project/$projectId")({
  ssr: false,
  beforeLoad: async () => {
    const session = await getSession();

    if (!session) {
      throw redirect({
        to: "/login",
        search: {
          redirectTo: location.href,
        },
      });
    }

    return { user: session.user };
  },
  loader: async ({ params }) => {
    const project = await getProject({
      data: {
        projectId: params.projectId,
      },
    });

    const files = createProjectFilesStore({
      initial: project.nodes,
      projectId: project.id,
    });
    await files.nodes.preload();
    return { project, files };
  },
  remountDeps: ({ params }) => params.projectId,
  component: () => (
    <SettingsProvider>
      <WorkspacePage />
    </SettingsProvider>
  ),
});

function WorkspacePage() {
  const { project, files } = Route.useLoaderData();
  return <ProjectWorkspace project={project} files={files} />;
}
