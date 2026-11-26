import { useMemo } from "react";

import {
  defaultSpellingLanguage,
  spellingLanguageSchema,
} from "#/lib/editor/spelling/languages";
import { editorThemes } from "#/lib/editor/themes/theme-extensions";
import type { ProjectDetails } from "#/lib/projects/project.functions";
import {
  ProjectFilesProvider,
  type createProjectFilesStore,
} from "#/providers/project-files-provider";
import { SettingsProvider } from "#/providers/settings-provider";
import { ThemeProvider } from "#/providers/theme-provider";

import { ProjectWorkspace } from "./project-workspace";

// The full editor, for signed-in people with access. Anonymous guests get
// `GuestWorkspace` instead and never download this module.
export function MemberWorkspace({
  project,
  files,
  userId,
}: {
  project: ProjectDetails;
  files: ReturnType<typeof createProjectFilesStore>;
  userId: string;
}) {
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
      setMainFile: files.setMainFile,
    }),
    [project, files],
  );
  return (
    <ThemeProvider userId={userId} editorThemes={editorThemes}>
      <SettingsProvider key={project.id} userId={userId} project={settings}>
        <ProjectFilesProvider store={files}>
          <ProjectWorkspace project={project} userId={userId} />
        </ProjectFilesProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}
