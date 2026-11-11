import "dockview-react/dist/styles/dockview.css";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconRefresh,
} from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
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
} from "dockview-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import { Editor } from "#/components/editor";
import { GeneratedFile } from "#/components/generated-file";
import {
  MarkdownPreview,
  type MarkdownPreviewParams,
} from "#/components/markdown-preview";
import { ProjectSidebar } from "#/components/project-sidebar";
import { Button } from "#/components/ui/button";
import { SidebarProvider, SidebarTrigger } from "#/components/ui/sidebar";
import { useLatexAnalysis } from "#/hooks/use-latex-analysis";
import { buildFileUrl, type BuildSnapshot } from "#/lib/build";
import { type LatexProblem } from "#/lib/latex/analysis";
import { parseCompileLog } from "#/lib/latex/compile-log";
import { requestCompilation } from "#/lib/latex/compile-project";
import { latexCompletion } from "#/lib/latex/completion";
import { ProjectBuildEvents } from "#/lib/latex/project-build-events";
import { projectPaths } from "#/lib/project-paths";
import type { ProjectDetails, ProjectNode } from "#/lib/project.functions";
import { useProjectFiles } from "#/providers/project-files-provider";
import { useSettings } from "#/providers/settings-provider";
import {
  type FileState,
  useWorkspace,
  type Workspace,
  WorkspaceProvider,
} from "#/providers/workspace-provider";

type FilePanelParams = { node: ProjectNode; preview: boolean };
const noProblems: LatexProblem[] = [];

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
      onSyntaxProblems={(problems) => workspace.reportSyntax(path, problems)}
      jump={workspace.jump?.id === params.node.id ? workspace.jump : undefined}
      formatSettings={workspace.formatSettings}
      onChange={(value) => workspace.change(params.node.id, value)}
      onOpenPreview={() => workspace.openMarkdownPreview(params.node.id)}
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
  const { pdf, stale } = useWorkspace();
  return (
    <div className="flex h-full min-h-0 flex-col">
      {pdf && stale && (
        <p
          role="status"
          className="text-muted-foreground border-b px-3 py-2 text-xs"
        >
          Out of date, recompile
        </p>
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<p className="p-4">Loading PDF viewer…</p>}>
          <PdfViewer file={pdf} />
        </Suspense>
      </div>
    </div>
  );
}

const components = {
  editor: FileEditor,
  generated: GeneratedFile,
  pdf: CompiledPdf,
  markdown: MarkdownPreview,
};
const tabComponents = { file: FileTab };
const savedSourcesSchema = z.record(z.string(), z.string());

export function ProjectWorkspace({ project }: { project: ProjectDetails }) {
  const files = useProjectFiles();
  const { id: projectId, name } = project;
  const { data: nodes } = useLiveQuery(files.nodes);
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
  const [syntaxProblems, setSyntaxProblems] = useState(
    new Map<string, LatexProblem[]>(),
  );
  const reportSyntax = useCallback((path: string, problems: LatexProblem[]) => {
    const next = problems.map((problem) => ({ ...problem, path }));
    setSyntaxProblems((previous) => {
      if (JSON.stringify(previous.get(path) ?? []) === JSON.stringify(next))
        return previous;
      return new Map(previous).set(path, next);
    });
  }, []);
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
  const lastEditAt = useRef<number | null>(null);
  const editorId = useRef(crypto.randomUUID());
  const editSequence = useRef(0);
  const [buildMetadata, setBuildMetadata] = useState<BuildSnapshot | null>(
    null,
  );
  const buildEvents = useRef<ProjectBuildEvents | null>(null);
  const sharedBuild = useRef<BuildSnapshot | null>(null);
  const completedJob = useRef<{
    id: string;
    revision: number | undefined;
  } | null>(null);
  const displayedPdfUrl = useRef<string | null>(null);
  const notifiedSequence = useRef(0);
  const notificationClosed = useRef(false);
  const notification = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [sourceChanged, setSourceChanged] = useState(false);
  useEffect(() => {
    notificationClosed.current = false;
    const events = new ProjectBuildEvents(projectId, (snapshot) => {
      sharedBuild.current = snapshot;
      setBuildMetadata(snapshot);
      if (!snapshot.stale && notifiedSequence.current >= editSequence.current)
        setSourceChanged(false);
    });
    buildEvents.current = events;
    return () => {
      notificationClosed.current = true;
      events.close();
      buildEvents.current = null;
      clearTimeout(notification.current);
      compilation.current?.abort();
    };
  }, [projectId]);

  const sharedPdf = buildMetadata?.artifacts?.files.find(
    (file) => file.path === buildMetadata.artifacts?.pdf,
  );
  const sharedPdfUrl = sharedPdf ? buildFileUrl(projectId, sharedPdf) : null;
  useEffect(() => {
    const completed = completedJob.current;
    if (completed) {
      // A recovery read may deliver the PDF before the SSE snapshot catches up.
      if (
        (completed.revision !== undefined &&
          (buildMetadata?.revision ?? -1) < completed.revision) ||
        (buildMetadata?.current?.id === completed.id &&
          ["queued", "running"].includes(buildMetadata.current.status))
      )
        return;
      if (buildMetadata?.artifacts?.id === completed.id && sharedPdfUrl) {
        displayedPdfUrl.current = sharedPdfUrl;
        return;
      }
    }
    if (!sharedPdfUrl) {
      completedJob.current = null;
      displayedPdfUrl.current = null;
      setPdf(null);
      return;
    }
    if (compiling || displayedPdfUrl.current === sharedPdfUrl) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(sharedPdfUrl, {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            "Could not load the shared PDF. Recompile to try again.",
          );
        const file = new File([await response.blob()], "output.pdf", {
          type: "application/pdf",
        });
        if (!controller.signal.aborted) {
          completedJob.current = null;
          displayedPdfUrl.current = sharedPdfUrl;
          setPdf(file);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setCompileError(
            error instanceof Error
              ? error.message
              : "Could not load the shared PDF.",
          );
      }
    })();
    return () => controller.abort();
  }, [sharedPdfUrl, compiling, buildMetadata]);
  const stale = sourceChanged || (buildMetadata?.stale ?? false);
  const structure = JSON.stringify(
    nodes
      .map(({ id, name, parentId, kind }) => ({ id, name, parentId, kind }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  const previousStructure = useRef(structure);
  useEffect(() => {
    if (previousStructure.current === structure) return;
    previousStructure.current = structure;
    setSourceChanged(true);
    notifySourceEdit();
  }, [structure]);

  function notifySourceEdit() {
    const sequence = ++editSequence.current;
    clearTimeout(notification.current);
    const send = async () => {
      try {
        const response = await fetch(
          `/api/compile/${encodeURIComponent(projectId)}?changed=1`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ editorId: editorId.current, sequence }),
            keepalive: true,
          },
        );
        if (!response.ok) throw new Error("Could not report source changes");
        notifiedSequence.current = Math.max(notifiedSequence.current, sequence);
      } catch {
        if (!notificationClosed.current && sequence === editSequence.current)
          notification.current = setTimeout(() => void send(), 2000);
      }
    };
    notification.current = setTimeout(() => void send(), 150);
  }

  const allProblems = useMemo(
    () => [
      ...result.analysis.problems,
      ...compileProblems,
      ...[...syntaxProblems]
        .filter(([path]) => filenames.includes(path))
        .flatMap(([, problems]) => problems),
    ],
    [result, compileProblems, syntaxProblems, filenames],
  );
  const problems = useMemo(() => {
    const byPath = new Map<string, LatexProblem[]>();
    for (const problem of [...result.analysis.problems, ...compileProblems]) {
      const list = byPath.get(problem.path) ?? [];
      list.push(problem);
      byPath.set(problem.path, list);
    }
    return byPath;
  }, [result, compileProblems]);

  const main =
    [...paths.values()].find((path) => path === "main.tex") ??
    [...paths.values()].find((path) => path.endsWith(".tex"));

  function sourceFiles() {
    return Object.fromEntries(
      nodes.flatMap((node) => {
        const path = paths.get(node.id);
        return node.kind === "text" && path
          ? [[path, drafts.current.get(node.id)?.value ?? ""]]
          : [];
      }),
    );
  }

  async function compileProject(clean = false) {
    const events = buildEvents.current;
    if (!main || !events) return;
    compilation.current?.abort();
    const startedAt = performance.now();
    const editedAt = lastEditAt.current;
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
    const files = sourceFiles();
    const sequence = ++editSequence.current;
    clearTimeout(notification.current);
    try {
      const result = await requestCompilation({
        projectId,
        events,
        clean,
        editorVersion: { editorId: editorId.current, sequence },
        startedAt,
        lastEditAt: editedAt,
        mainFile: main,
        files,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10 * 60_000),
        ]),
      });
      if (controller.signal.aborted) return;
      if ("pdf" in result) {
        const latest = sharedBuild.current;
        if (
          latest?.current?.id === result.jobId ||
          (result.revision !== undefined &&
            (latest?.current?.revision ?? -1) <= result.revision)
        ) {
          completedJob.current = {
            id: result.jobId,
            revision: result.revision,
          };
          setPdf(result.pdf);
        }
        notifiedSequence.current = Math.max(notifiedSequence.current, sequence);
        setSourceChanged(revision.current !== snapshot);
      } else setCompileError(result.error);
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
      if (compilation.current === controller) {
        compilation.current = null;
        setCompiling(false);
      }
    }
  }

  function cycleTab(direction: number) {
    const panels =
      api.current?.panels.filter((panel) => panel.api.component === "editor") ??
      [];
    const activePanel = api.current?.activePanel;
    const currentId =
      activePanel?.api.component === "editor" ? activePanel.id : activeId;
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
    api.current
      ?.getPanel(`markdown:${id}`)
      ?.api.updateParameters({ source: value });
    const path = paths.get(id);
    if (path && previous.value !== value) {
      lastEditAt.current = performance.now();
      setSourceChanged(true);
      notifySourceEdit();
      update(path, value);
      setCompileProblems((current) => (current.length ? [] : current));
    }
    keepOpen(id);
    const panel = api.current?.getPanel(id);
    const node = nodes.find((node) => node.id === id);
    if (node)
      panel?.api.setTitle(`${node.name}${value !== savedValue ? " ●" : ""}`);
  }

  function openMarkdownPreview(id: string) {
    const dock = api.current;
    const node = nodes.find((node) => node.id === id);
    if (!dock || !node || !/\.(?:md|markdown)$/i.test(node.name)) return;
    keepOpen(id);
    const existing = dock.getPanel(`markdown:${id}`);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const reference = dock.panels.find(
      (panel) => panel.api.component !== "editor",
    );
    dock.addPanel<MarkdownPreviewParams>({
      id: `markdown:${id}`,
      component: "markdown",
      title: `Preview: ${node.name}`,
      params: { source: drafts.current.get(id)?.value ?? "" },
      position: reference
        ? { referencePanel: reference.id, direction: "within" }
        : { referencePanel: id, direction: "right" },
    });
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
      preview ?? dock.panels.find((panel) => panel.api.component === "editor");
    const previewPanel = dock.panels.find(
      (panel) => panel.api.component !== "editor",
    );
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
        : previewPanel
          ? { referencePanel: previewPanel.id, direction: "left" }
          : undefined,
    });
    if (!permanent) {
      previewId.current = node.id;
      if (preview) dock.removePanel(preview);
    }
  }

  function openGenerated(path: string) {
    const dock = api.current;
    if (!dock) return;
    const id = `out:${path}`;
    const existing = dock.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const reference = dock.panels.find(
      (panel) => panel.api.component === "editor",
    );
    dock.addPanel({
      id,
      component: "generated",
      title: `out/${path}`,
      params: { path },
      position: reference
        ? { referencePanel: reference.id, direction: "within" }
        : undefined,
    });
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
        if (
          panel &&
          (panel.api.component === "editor" ||
            panel.api.component === "generated")
        )
          setActiveId(panel.id);
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
    <WorkspaceProvider
      value={{
        projectId,
        build: buildMetadata,
        stale,
        drafts: drafts.current,
        keepOpen,
        openMarkdownPreview,
        change,
        paths,
        completion,
        problems,
        reportSyntax,
        jump,
        pdf,
        formatSettings,
      }}
    >
      <SidebarProvider
        ref={container}
        className="h-svh min-h-0 flex-col overflow-hidden [--workspace-footer-height:2.25rem] [--workspace-header-height:3rem] **:data-[slot=sidebar-container]:transition-none **:data-[slot=sidebar-gap]:transition-none"
      >
        <header className="z-20 flex h-(--workspace-header-height) shrink-0 items-center gap-2 border-b bg-(--activity-background) px-3 text-(--activity-foreground)">
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
          {pdf && stale && (
            <span role="status" className="text-muted-foreground text-xs">
              Out of date, recompile
            </span>
          )}
          <Button
            variant="outline"
            disabled={!main || compiling}
            aria-label="Clean build"
            title="Clean build"
            onClick={() => void compileProject(true)}
          >
            <IconRefresh />
            <span className="hidden md:inline">Clean build</span>
          </Button>
          <Button disabled={!main} onClick={() => void compileProject()}>
            {compiling ? "Compiling…" : "Save & compile"}
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ProjectSidebar
            name={name}
            nodes={nodes}
            activeId={activeId}
            ready={ready}
            onOpen={openFile}
            onOpenGenerated={openGenerated}
            sources={sourceFiles}
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
                  theme={{
                    name: "texfolia",
                    className: "dockview-theme-texfolia",
                  }}
                  components={components}
                  tabComponents={tabComponents}
                  onReady={onReady}
                />
              </ClientOnly>
            </div>
            {showProblems && (
              <section
                aria-label="LaTeX problems"
                className="max-h-44 shrink-0 overflow-auto border-t bg-(--panel-background) px-3 py-2 text-sm"
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
        <footer className="z-20 flex h-(--workspace-footer-height) shrink-0 items-center justify-between gap-3 border-t bg-(--status-background) px-3 text-xs text-(--status-foreground)">
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
    </WorkspaceProvider>
  );
}
