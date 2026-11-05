import "dockview-react/dist/styles/dockview.css";
import { ClientOnly, Link } from "@tanstack/react-router";
import {
  type DockviewApi,
  DockviewDefaultTab,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  themeLight,
} from "dockview-react";
import { ArrowLeft } from "lucide-react";
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

import { Editor } from "#/components/editor";
import {
  LatexFormatSettings,
  useLatexFormatSettings,
} from "#/components/latex-format-settings";
import {
  ProjectFileTree,
  type ProjectNode,
} from "#/components/project-file-tree";
import { Button } from "#/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "#/components/ui/sidebar";
import { useLatexAnalysis } from "#/hooks/use-latex-analysis";
import { type LatexProblem } from "#/lib/latex/analysis";
import { parseCompileLog } from "#/lib/latex/compile-log";
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

function FileEditor({ params }: IDockviewPanelProps<FilePanelParams>) {
  const workspace = useWorkspace();
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
      filename={params.node.name}
      defaultValue={draft?.value ?? ""}
      defaultSavedValue={draft?.savedValue ?? ""}
      allowOpenFile={false}
      completion={workspace.completion}
      problems={workspace.problems.get(path) ?? noProblems}
      jump={workspace.jump?.id === params.node.id ? workspace.jump : undefined}
      formatSettings={workspace.formatSettings}
      onChange={(value) => workspace.change(params.node.id, value)}
      onSave={(value) => workspace.change(params.node.id, value, true)}
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
  const { settings: formatSettings, update: updateFormatSettings } =
    useLatexFormatSettings();
  const compileInFlight = useRef(false);

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
    if (!main || compileInFlight.current) return;
    compileInFlight.current = true;
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
      const response = await fetch(
        `/api/compile/${encodeURIComponent(projectId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mainFile: main, files }),
        },
      );
      let log: string;
      if (response.ok) {
        const form = await response.formData();
        const file = form.get("pdf");
        const transcript = form.get("log");
        if (!(file instanceof File) || typeof transcript !== "string")
          throw new Error("Invalid compiler result");
        setPdf(file);
        log = transcript;
      } else {
        const failure: unknown = await response.json();
        setCompileError(
          failure &&
            typeof failure === "object" &&
            "error" in failure &&
            typeof failure.error === "string"
            ? failure.error
            : "Compilation failed",
        );
        log =
          failure &&
          typeof failure === "object" &&
          "log" in failure &&
          typeof failure.log === "string"
            ? failure.log
            : "";
      }
      const diagnostics = parseCompileLog(log, filenames, main);
      if (revision.current === snapshot) {
        setCompileProblems(diagnostics);
        if (diagnostics.length) setShowProblems(true);
      }
    } catch {
      setCompileError("The compiler could not be reached. Try again.");
    } finally {
      compileInFlight.current = false;
      setCompiling(false);
    }
  }

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
      <SidebarProvider className="h-svh overflow-hidden">
        <Sidebar variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link to="/projects" />}>
                  <ArrowLeft />
                  Back to Projects
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel title={name}>{name}</SidebarGroupLabel>
              <SidebarGroupContent aria-busy={!ready}>
                <ProjectFileTree
                  nodes={nodes}
                  activeId={activeId}
                  onOpen={openFile}
                />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <header className="flex shrink-0 items-center gap-2 border-b p-2">
            <SidebarTrigger />
            <Button
              disabled={!main || compiling}
              onClick={() => void compileProject()}
            >
              {compiling ? "Compiling…" : "Compile"}
            </Button>
            <Button
              variant="outline"
              aria-expanded={showProblems}
              onClick={() => setShowProblems(!showProblems)}
            >
              Problems ({allProblems.length})
            </Button>
            <LatexFormatSettings
              settings={formatSettings}
              onChange={updateFormatSettings}
            />
          </header>
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
        </SidebarInset>
      </SidebarProvider>
    </WorkspaceContext.Provider>
  );
}
