import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import type { ProjectDetails } from "../../src/lib/project.functions";
import {
  createProjectFilesStore,
  ProjectFilesProvider,
} from "../../src/providers/project-files-provider";
import { SettingsProvider } from "../../src/providers/settings-provider";
import { ThemeProvider } from "../../src/providers/theme-provider";
import { ProjectWorkspace } from "../../src/routes/project/$projectId/-components/project-workspace";

import "../../src/styles.css";

const project: ProjectDetails = await (await fetch("/fixture/project")).json();
const files = createProjectFilesStore({
  initial: project.nodes,
  projectId: project.id,
  initialSourceVersions: project.sourceVersions,
});
await files.nodes.preload();

const route = createRootRoute({
  component: () => (
    <ThemeProvider userId="upload-test">
      <SettingsProvider
        userId="upload-test"
        project={{
          id: project.id,
          canWrite: project.canWrite,
          formatting: {
            indent: project.formatIndent,
            wrap: project.formatWrap,
            width: project.formatWidth,
          },
          spelling: "off",
        }}
      >
        <ProjectFilesProvider store={files}>
          <ProjectWorkspace project={project} userId="upload-test" />
        </ProjectFilesProvider>
      </SettingsProvider>
    </ThemeProvider>
  ),
});
const router = createRouter({
  routeTree: route,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<RouterProvider router={router} />);

const api = {
  create: files.create,
  refresh: () => files.refresh(),
  nodes: () => files.nodes.toArray,
  versions: () => files.sourceVersions,
  snapshotVersions: () => project.sourceVersions,
  textSources: () => Object.fromEntries(files.createdTextSources),
  remove: async (id: string) => files.nodes.delete(id).when("settled"),
};
Object.assign(window, { uploadTest: api });
export type UploadTest = typeof api;
