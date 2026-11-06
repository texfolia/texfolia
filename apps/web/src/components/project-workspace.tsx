import "dockview-react/dist/styles/dockview.css";
import { IconAlertCircle, IconArrowLeft, IconFiles } from "@tabler/icons-react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { ClientOnly, Link } from "@tanstack/react-router";
import type { EditorView } from "@uiw/react-codemirror";
import {
  type DockviewApi,
  DockviewDefaultTab,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  themeLight,
} from "dockview-react";
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import { Editor } from "#/components/editor";
import {
  ProjectFileTree,
  type ProjectNode,
} from "#/components/project-file-tree";
import { SettingsDialog } from "#/components/settings-dialog";
import { Button } from "#/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "#/components/ui/sidebar";
import { useLatexAnalysis } from "#/hooks/use-latex-analysis";
import { useSettings } from "#/hooks/use-settings";
import { type LatexProblem } from "#/lib/latex/analysis";
import { parseCompileLog } from "#/lib/latex/compile-log";
import { requestCompilation } from "#/lib/latex/compile-project";
import { latexCompletion } from "#/lib/latex/completion";
import type { FormatSettings } from "#/lib/latex/format";

type FileState = { value: string; savedValue: string };
type FilePanelParams = { node: ProjectNode; preview: boolean };
type Workspace = {
  drafts: Map<string, FileState>;
  paths: ReadonlyMap<string, string>;
  completion: ReturnType<typeof latexCompletion>;
  problems: ReadonlyMap<string, LatexProblem[]>;
  jump: { id: string; line: number } | undefined;
  pdf: File | null;
  formatSettings: FormatSettings;
  keepOpen: (id: string) => void;
  change: (id: string, value: string, saved?: boolean) => void;
};
const WorkspaceContext = createContext<Workspace | null>(null);
function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("Missing project workspace");
  return workspace;
}
const noProblems: LatexProblem[] = [];

function projectPaths(nodes: ProjectNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots = nodes.filter((node) => node.parentId === null);
  const root =
    roots.length === 1 && roots[0]?.kind === "folder" ? roots[0].id : undefined;
  const paths = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === "folder") continue;
    const segments = [node.name];
    const visited = new Set([node.id]);
    let parent = node.parentId;
    while (parent && parent !== root && !visited.has(parent)) {
      visited.add(parent);
      const folder = byId.get(parent);
      if (!folder) break;
      segments.unshift(folder.name);
      parent = folder.parentId;
    }
    paths.set(node.id, segments.join("/"));
  }
  return paths;
}

const PdfViewer = lazy(() => import("#/components/pdf"));

function FileEditor({
  params,
  api: panelApi,
}: IDockviewPanelProps<FilePanelParams>) {
  const workspace = useWorkspace();
  const editor = useRef<EditorView | null>(null);
  useEffect(() => {
    let frame = 0;
    const subscription = panelApi.onDidActiveChange(({ isActive }) => {
      cancelAnimationFrame(frame);
      if (isActive)
        frame = requestAnimationFrame(() => editor.current?.focus());
    });
    return () => {
      cancelAnimationFrame(frame);
      subscription.dispose();
    };
  }, [panelApi]);
  const draft = workspace.drafts.get(params.node.id);
  const path = workspace.paths.get(params.node.id) ?? params.node.name;
  if (params.node.kind === "binary")
    return (
      <p className="text-muted-foreground p-4 text-sm">
        Preview is not available for this file type.
      </p>
    );
  return (
    <Editor
      onCreateEditor={(view) => {
        editor.current = view;
        if (panelApi.isActive) view.focus();
      }}
      filename={params.node.name}
      defaultValue={draft?.value ?? ""}
      savedValue={draft?.savedValue ?? ""}
      allowOpenFile={false}
      completion={workspace.completion}
      problems={workspace.problems.get(path) ?? noProblems}
      jump={workspace.jump?.id === params.node.id ? workspace.jump : undefined}
      formatSettings={workspace.formatSettings}
      onChange={(value) => workspace.change(params.node.id, value)}
    />
  );
}

function FileTab(props: IDockviewPanelHeaderProps<FilePanelParams>) {
  const workspace = useWorkspace();
  return (
    <div
      className="h-full"
      style={{ fontStyle: props.params.preview ? "italic" : "normal" }}
    >
      <DockviewDefaultTab
        {...props}
        onDoubleClick={() => workspace.keepOpen(props.api.id)}
      />
    </div>
  );
}

function CompiledPdf() {
  const { pdf } = useWorkspace();
  return (
    <div className="h-full overflow-auto">
      <Suspense fallback={<p className="p-4">Loading PDF viewer…</p>}>
        <PdfViewer file={pdf} />
      </Suspense>
    </div>
  );
}

const components = { editor: FileEditor, pdf: CompiledPdf };
const tabComponents = { file: FileTab };
const savedSourcesSchema = z.record(z.string(), z.string());

function WorkspaceSidebar({
  name,
  nodes,
  activeId,
  ready,
  onOpen,
  showProblems,
  onToggleProblems,
}: {
  name: string;
  nodes: ProjectNode[];
  activeId: string | undefined;
  ready: boolean;
  onOpen: (node: ProjectNode, permanent: boolean) => void;
  showProblems: boolean;
  onToggleProblems: () => void;
}) {
  const { setOpen, toggleSidebar } = useSidebar();

  useHotkeys([{ hotkey: "Mod+B", callback: toggleSidebar }], {
    ignoreInputs: false,
    ignoreDefaultPrevented: true,
  });

  return (
    <Sidebar
      collapsible="icon"
      className="top-(--workspace-header-height) bottom-(--workspace-footer-height) h-auto overflow-hidden"
    >
      <div className="flex size-full">
        <Sidebar
          collapsible="none"
          className="w-(--sidebar-width-icon)! shrink-0 border-r"
        >
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu aria-label="Workspace navigation">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="Project files"
                    aria-label="Project files"
                    isActive
                    onClick={() => setOpen(true)}
                  >
                    <IconFiles />
                    <span className="sr-only">Project files</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="Problems"
                    aria-label="Problems"
                    aria-expanded={showProblems}
                    onClick={onToggleProblems}
                  >
                    <IconAlertCircle />
                    <span className="sr-only">Problems</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SettingsDialog iconOnly />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <Sidebar
          collapsible="none"
          className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden"
        >
          <SidebarHeader className="h-11 justify-center border-b px-4">
            <h2 className="text-sm font-medium">Files</h2>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel title={name}>{name}</SidebarGroupLabel>
              <SidebarGroupContent aria-busy={!ready}>
                <ProjectFileTree
                  nodes={nodes}
                  activeId={activeId}
                  onOpen={onOpen}
                />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </div>
    </Sidebar>
  );
}

export function ProjectWorkspace({
  projectId,
  name,
  nodes,
}: {
  projectId: string;
  name: string;
  nodes: ProjectNode[];
}) {
  const api = useRef<DockviewApi | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const previewId = useRef<string | null>(null);
  const drafts = useRef(new Map<string, FileState>());
  const subscriptions = useRef<Array<{ dispose: () => void }>>([]);
  const [activeId, setActiveId] = useState<string>();
  const [ready, setReady] = useState(false);
  const paths = useMemo(() => projectPaths(nodes), [nodes]);
  const filenames = useMemo(() => [...paths.values()], [paths]);
  const { result, update, revision } = useLatexAnalysis(filenames);
  const currentAnalysis = useRef(result.analysis);
  currentAnalysis.current = result.analysis;
  const completion = useMemo(
    () => latexCompletion(() => currentAnalysis.current, filenames),
    [filenames],
  );
  const [compileProblems, setCompileProblems] = useState<LatexProblem[]>([]);
  const [pdf, setPdf] = useState<File | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState("");
  const [jump, setJump] = useState<Workspace["jump"]>();
  const [showProblems, setShowProblems] = useState(false);
  const {
    formatting: { settings: formatSettings },
    open: settingsOpen,
  } = useSettings();
  const storageKey = `texfolia.project.${projectId}.sources`;
  const compilation = useRef<AbortController | null>(null);
  useEffect(() => () => compilation.current?.abort(), [projectId]);

  const allProblems = useMemo(
    () => [...result.analysis.problems, ...compileProblems],
    [result, compileProblems],
  );
  const problems = useMemo(() => {
    const byPath = new Map<string, LatexProblem[]>();
    for (const problem of allProblems) {
      const list = byPath.get(problem.path) ?? [];
      list.push(problem);
      byPath.set(problem.path, list);
    }
    return byPath;
  }, [allProblems]);

  const main =
    [...paths.values()].find((path) => path === "main.tex") ??
    [...paths.values()].find((path) => path.endsWith(".tex"));

  async function compileProject() {
    if (!main || compilation.current) return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(
          Object.fromEntries(
            [...drafts.current].map(([id, draft]) => [id, draft.value]),
          ),
        ),
      );
      for (const [id, draft] of drafts.current) change(id, draft.value, true);
    } catch {
      setCompileError(
        "Could not save sources in this browser. Download your files to keep a copy, then free browser storage and try again.",
      );
      return;
    }
    const controller = new AbortController();
    compilation.current = controller;
    setCompiling(true);
    setCompileError("");
    setCompileProblems([]);
    const snapshot = revision.current;
    const files = Object.fromEntries(
      nodes.flatMap((node) => {
        const path = paths.get(node.id);
        return node.kind === "text" && path
          ? [[path, drafts.current.get(node.id)?.value ?? ""]]
          : [];
      }),
    );
    try {
      const result = await requestCompilation({
        projectId,
        mainFile: main,
        files,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10 * 60_000),
        ]),
      });
      if ("pdf" in result) setPdf(result.pdf);
      else setCompileError(result.error);
      const diagnostics = parseCompileLog(result.log, filenames, main);
      if (revision.current === snapshot) {
        setCompileProblems(diagnostics);
        if (diagnostics.length) setShowProblems(true);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setCompileError(
        error instanceof DOMException && error.name === "TimeoutError"
          ? "The compile job is taking longer than expected. Try again in a few minutes."
          : "The compiler could not be reached. Try again.",
      );
    } finally {
      compilation.current = null;
      setCompiling(false);
    }
  }

  function cycleTab(direction: number) {
    const panels =
      api.current?.panels.filter((panel) => panel.id !== "pdf") ?? [];
    const currentId = api.current?.activePanel?.id ?? activeId;
    const index = panels.findIndex((panel) => panel.id === currentId);
    panels[
      (index + direction + panels.length) % panels.length
    ]?.api.setActive();
  }

  useHotkeys(
    [
      { hotkey: "Mod+S", callback: () => void compileProject() },
      { hotkey: "Control+PageDown", callback: () => cycleTab(1) },
      { hotkey: "Control+PageUp", callback: () => cycleTab(-1) },
    ],
    {
      target: container,
      capture: true,
      ignoreInputs: false,
      enabled: !settingsOpen,
    },
  );

  useEffect(
    () => () => {
      subscriptions.current.forEach((subscription) => subscription.dispose());
    },
    [],
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        [...drafts.current.values()].some(
          (draft) => draft.value !== draft.savedValue,
        )
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  function keepOpen(id: string) {
    if (previewId.current !== id) return;
    previewId.current = null;
    api.current?.getPanel(id)?.api.updateParameters({ preview: false });
  }

  function change(id: string, value: string, saved = false) {
    const previous = drafts.current.get(id) ?? { value: "", savedValue: "" };
    const savedValue = saved ? value : previous.savedValue;
    drafts.current.set(id, { value, savedValue });
    const path = paths.get(id);
    if (path && previous.value !== value) {
      update(path, value);
      setCompileProblems((current) => (current.length ? [] : current));
    }
    keepOpen(id);
    const panel = api.current?.getPanel(id);
    const node = nodes.find((node) => node.id === id);
    if (node)
      panel?.api.setTitle(`${node.name}${value !== savedValue ? " ●" : ""}`);
  }

  function openFile(node: ProjectNode, permanent: boolean) {
    const dock = api.current;
    if (!dock) return;
    const existing = dock.getPanel(node.id);
    if (existing) {
      if (permanent) keepOpen(node.id);
      existing.api.setActive();
      return;
    }
    const preview = previewId.current
      ? dock.getPanel(previewId.current)
      : undefined;
    const reference =
      preview ?? dock.panels.find((panel) => panel.id !== "pdf");
    const draft = drafts.current.get(node.id);
    dock.addPanel<FilePanelParams>({
      id: node.id,
      component: "editor",
      tabComponent: "file",
      title: `${node.name}${draft && draft.value !== draft.savedValue ? " ●" : ""}`,
      params: {
        node,
        preview: !permanent,
      },
      renderer: "always",
      position: reference
        ? { referencePanel: reference.id, direction: "within" }
        : dock.getPanel("pdf")
          ? { referencePanel: "pdf", direction: "left" }
          : undefined,
    });
    if (!permanent) {
      previewId.current = node.id;
      if (preview) dock.removePanel(preview);
    }
  }

  function onReady({ api: dock }: DockviewReadyEvent) {
    api.current = dock;
    try {
      const saved = savedSourcesSchema.safeParse(
        JSON.parse(localStorage.getItem(storageKey) ?? "null"),
      );
      if (saved.success) {
        for (const node of nodes) {
          const value = saved.data[node.id];
          const path = paths.get(node.id);
          if (node.kind === "text" && value !== undefined && path) {
            drafts.current.set(node.id, { value, savedValue: value });
            update(path, value);
          }
        }
      }
    } catch {
      setCompileError("Saved sources could not be read from this browser.");
    }
    subscriptions.current.forEach((subscription) => subscription.dispose());
    subscriptions.current = [
      dock.onDidActivePanelChange(({ panel }) => {
        if (panel?.id !== "pdf") setActiveId(panel?.id);
      }),
      dock.onDidRemovePanel((panel) => {
        if (previewId.current === panel.id) previewId.current = null;
      }),
    ];
    const first =
      nodes.find((node) => node.kind === "text" && node.name === "main.tex") ??
      nodes.find((node) => node.kind === "text");
    if (first) openFile(first, true);
    dock.addPanel({
      id: "pdf",
      component: "pdf",
      title: "PDF Preview",
      position: first
        ? { referencePanel: first.id, direction: "right" }
        : undefined,
    });
    if (first) dock.getPanel(first.id)?.api.setActive();
    setReady(true);
  }

  return (
    <WorkspaceContext.Provider
      value={{
        drafts: drafts.current,
        keepOpen,
        change,
        paths,
        completion,
        problems,
        jump,
        pdf,
        formatSettings,
      }}
    >
      <SidebarProvider
        ref={container}
        keyboardShortcut={false}
        className="h-svh min-h-0 flex-col overflow-hidden [--workspace-footer-height:2.25rem] [--workspace-header-height:3rem] [&_[data-slot=sidebar-container]]:transition-none [&_[data-slot=sidebar-gap]]:transition-none"
      >
        <header className="bg-background z-20 flex h-(--workspace-header-height) shrink-0 items-center gap-2 border-b px-3">
          <Button
            render={<Link to="/projects" />}
            variant="ghost"
            size="icon-sm"
            aria-label="Back to Projects"
            title="Back to Projects"
          >
            <IconArrowLeft />
          </Button>
          <SidebarTrigger />
          <span className="bg-border mx-1 h-4 w-px shrink-0" />
          <h1
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={name}
          >
            {name}
          </h1>
          <Button
            disabled={!main || compiling}
            onClick={() => void compileProject()}
          >
            {compiling ? "Compiling…" : "Save & compile"}
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <WorkspaceSidebar
            name={name}
            nodes={nodes}
            activeId={activeId}
            ready={ready}
            onOpen={openFile}
            showProblems={showProblems}
            onToggleProblems={() => setShowProblems(!showProblems)}
          />
          <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {compileError && (
              <p
                role="alert"
                className="text-destructive border-b px-3 py-2 text-sm"
              >
                {compileError}
              </p>
            )}
            <div className="min-h-0 flex-1">
              <ClientOnly>
                <DockviewReact
                  className="size-full"
                  theme={themeLight}
                  components={components}
                  tabComponents={tabComponents}
                  onReady={onReady}
                />
              </ClientOnly>
            </div>
            {showProblems && (
              <section
                aria-label="LaTeX problems"
                className="max-h-44 shrink-0 overflow-auto border-t px-3 py-2 text-sm"
              >
                {allProblems.length ? (
                  <ul className="space-y-1">
                    {allProblems.map((problem, index) => (
                      <li key={`${problem.path}:${problem.line}:${index}`}>
                        <Button
                          variant="ghost"
                          className="h-auto justify-start text-left whitespace-normal"
                          onClick={() => {
                            const node = nodes.find(
                              (candidate) =>
                                paths.get(candidate.id) === problem.path,
                            );
                            if (!node) return;
                            openFile(node, true);
                            setJump({ id: node.id, line: problem.line });
                          }}
                        >
                          <span
                            className={
                              problem.severity === "error"
                                ? "text-destructive"
                                : "text-muted-foreground"
                            }
                          >
                            {problem.path}:{problem.line}
                          </span>
                          {problem.message}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">No problems.</p>
                )}
              </section>
            )}
          </main>
        </div>
        <footer className="bg-background text-muted-foreground z-20 flex h-(--workspace-footer-height) shrink-0 items-center justify-between gap-3 border-t px-3 text-xs">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            aria-expanded={showProblems}
            onClick={() => setShowProblems(!showProblems)}
          >
            <IconAlertCircle />
            Problems ({allProblems.length})
          </Button>
          <span className="min-w-0 truncate">
            {activeId ? paths.get(activeId) : "LaTeX workspace"}
          </span>
        </footer>
      </SidebarProvider>
    </WorkspaceContext.Provider>
  );
}
