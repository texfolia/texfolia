import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  defaultSpellingLanguage,
  spellingLanguageSchema,
} from "@texfolia/editor/spelling/languages";

import { getProject } from "#/lib/project.functions";
import {
  createProjectFilesStore,
  ProjectFilesProvider,
} from "#/providers/project-files-provider";
import { SettingsProvider } from "#/providers/settings-provider";
import { ThemeProvider } from "#/providers/theme-provider";

import { ProjectWorkspace } from "./-components/project-workspace";

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
      initialSourceVersions: project.sourceVersions,
    });
    await files.nodes.preload();
    return { project, files };
  },
  remountDeps: ({ params }) => params.projectId,
  component: ThemedWorkspace,
});

function WorkspacePage() {
  const { project, files } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  return (
    <ProjectFilesProvider store={files}>
      <ProjectWorkspace project={project} userId={user.id} />
    </ProjectFilesProvider>
  );
}

function ThemedWorkspace() {
  const { user } = Route.useRouteContext();
  const { project } = Route.useLoaderData();
  return (
    <ThemeProvider userId={user.id}>
      <SettingsProvider
        key={project.id}
        userId={user.id}
        project={{
          id: project.id,
          canWrite: project.canWrite,
          formatting: {
            indent: project.formatIndent,
            wrap: project.formatWrap,
            width: project.formatWidth,
          },
          spelling: spellingLanguageSchema
            .catch(defaultSpellingLanguage)
            .parse(project.spellcheckLanguage),
        }}
      >
        <WorkspacePage />
      </SettingsProvider>
    </ThemeProvider>
  );
}
