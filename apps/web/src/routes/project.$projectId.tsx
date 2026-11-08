import { createFileRoute, redirect } from "@tanstack/react-router";

import { ProjectWorkspace } from "#/components/project-workspace";
import { getSession } from "#/lib/auth.functions";
import { getProject } from "#/lib/project.functions";
import {
  createProjectFilesStore,
  ProjectFilesProvider,
} from "#/providers/project-files-provider";
import { SettingsProvider } from "#/providers/settings-provider";

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
  return (
    <ProjectFilesProvider store={files}>
      <ProjectWorkspace project={project} />
    </ProjectFilesProvider>
  );
}
