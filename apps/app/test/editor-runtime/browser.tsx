import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EditorView } from "@uiw/react-codemirror";
import { Profiler } from "react";
import { createRoot } from "react-dom/client";

import { editorThemes } from "../../src/lib/editor/themes/theme-extensions";
import type { ProjectDetails } from "../../src/lib/projects/project.functions";
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

// React's own measure of the work done below it, and each worker by its file.
const rendered = { commits: 0, ms: 0 };
const settings = {
  id: project.id,
  canWrite: project.canWrite,
  formatting: { indent: 2, wrap: true, width: 80 },
  spelling: "off" as const,
  setMainFile: files.setMainFile,
};
const route = createRootRoute({
  component: () => (
    <ThemeProvider userId="runtime-test" editorThemes={editorThemes}>
      <SettingsProvider userId="runtime-test" project={settings}>
        <ProjectFilesProvider store={files}>
          <Profiler
            id="workspace"
            onRender={(_id, _phase, actualDuration) => {
              rendered.commits++;
              rendered.ms += actualDuration;
            }}
          >
            <ProjectWorkspace project={project} userId="runtime-test" />
          </Profiler>
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

function view() {
  const element = document.querySelector<HTMLElement>(".cm-editor");
  const found = element && EditorView.findFromDOM(element);
  if (!found) throw new Error("No editor is shown");
  return found;
}

const api = {
  create: files.create,
  refresh: () => files.refresh(),
  takeRendered: () => {
    const taken = { ...rendered };
    Object.assign(rendered, { commits: 0, ms: 0 });
    return taken;
  },
  text: () => view().state.doc.toString(),
  /** Replaces what differs, as a collaborator's edit would. */
  replace: (text: string) => {
    const { state, dispatch } = view();
    const current = state.doc.toString();
    let from = 0;
    while (
      from < Math.min(current.length, text.length) &&
      current[from] === text[from]
    )
      from++;
    let end = 0;
    while (
      end < Math.min(current.length, text.length) - from &&
      current.at(-1 - end) === text.at(-1 - end)
    )
      end++;
    dispatch({
      changes: {
        from,
        to: current.length - end,
        insert: text.slice(from, text.length - end),
      },
    });
  },
  select: (anchor: number, head = anchor) => {
    view().focus();
    view().dispatch({ selection: { anchor, head } });
  },
};
Object.assign(window, { runtimeTest: api });
export type RuntimeTest = typeof api;
