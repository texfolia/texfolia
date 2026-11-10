import { createFileRoute, redirect } from "@tanstack/react-router";

import { ProjectWorkspace } from "#/components/project-workspace";
import { getProject } from "#/lib/project.functions";
import {
  createProjectFilesStore,
  ProjectFilesProvider,
} from "#/providers/project-files-provider";
import { SettingsProvider } from "#/providers/settings-provider";
import { ThemeProvider } from "#/providers/theme-provider";

export const Route = createFileRoute("/project/$projectId")({
  ssr: false,
  beforeLoad: ({ location, context }) => {
    const user = context.appUser;
    if (!user) {
      throw redirect({
        to: "/login",
        search: {
          redirectTo: location.pathname,
        },
      });
    }

    return { user };
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
  component: ThemedWorkspace,
});

function WorkspacePage() {
  const { project, files } = Route.useLoaderData();
  return (
    <ProjectFilesProvider store={files}>
      <ProjectWorkspace project={project} />
    </ProjectFilesProvider>
  );
}

function ThemedWorkspace() {
  const { user } = Route.useRouteContext();
  return (
    <ThemeProvider userId={user.id}>
      <SettingsProvider>
        <WorkspacePage />
      </SettingsProvider>
    </ThemeProvider>
  );
}
