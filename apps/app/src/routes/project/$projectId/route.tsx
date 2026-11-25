import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo } from "react";

import {
  defaultSpellingLanguage,
  spellingLanguageSchema,
} from "#/lib/editor/spelling/languages";
import { editorThemes } from "#/lib/editor/themes/theme-extensions";
import { getProject } from "#/lib/projects/project.functions";
import { ProjectFilesProvider } from "#/providers/project-files-provider";
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
    // Loaders are part of every page's first bundle; the store is not.
    const [project, { createProjectFilesStore }] = await Promise.all([
      getProject({ data: { projectId: params.projectId } }),
      import("#/providers/project-files-provider"),
    ]);

    const files = createProjectFilesStore({
      initial: project.nodes,
      projectId: project.id,
      initialSourceVersions: project.sourceVersions,
      commentsVersion: project.commentsVersion,
      gitVersion: project.gitVersion,
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
  const settings = useMemo(
    () => ({
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
    }),
    [project],
  );
  return (
    <ThemeProvider userId={user.id} editorThemes={editorThemes}>
      <SettingsProvider key={project.id} userId={user.id} project={settings}>
        <WorkspacePage />
      </SettingsProvider>
    </ThemeProvider>
  );
}
