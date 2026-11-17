import {
  IconAlertCircle,
  IconLayoutSidebarLeftExpand,
  IconFiles,
  IconListTree,
  IconHistory,
  IconUsers,
  IconGitBranch,
  IconPlayerPlay,
  IconLoader2,
  IconCircleCheck,
} from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
import { ClientOnly } from "@tanstack/react-router";

import "dockview-react/dist/styles/dockview.css";
import type { EditorView } from "@uiw/react-codemirror";
import { cn } from "cn";
import {
  type DockviewApi,
  DockviewDefaultTab,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { SettingsDialog } from "#/components/settings-dialog";
import { Button } from "#/components/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "#/components/ui/context-menu";
import { SidebarProvider } from "#/components/ui/sidebar";
import { useLatexAnalysis } from "#/hooks/use-latex-analysis";
import { useSyncTex } from "#/hooks/use-synctex";
import { buildFileUrl, type BuildSnapshot } from "#/lib/build";
import {
  documentCachingStopped,
  stopDocumentCaching,
} from "#/lib/collaboration/cache";
import { CollaborativeFile } from "#/lib/collaboration/file";
import { downloadFile } from "#/lib/download-file";
import type { EditorCommand } from "#/lib/editor-command";
import { gitAction } from "#/lib/git.functions";
import { type LatexProblem } from "#/lib/latex/analysis";
import { parseCompileLog } from "#/lib/latex/compile-log";
import { requestCompilation } from "#/lib/latex/compile-project";
import { latexCompletion } from "#/lib/latex/completion";
import { projectOutline } from "#/lib/latex/outline";
import { ProjectBuildEvents } from "#/lib/latex/project-build-events";
import type { CompileSources } from "#/lib/latex/source-sync";
import { addLatexPackage, packageInsertion } from "#/lib/latex/symbols";
import { sourceToPdf } from "#/lib/latex/synctex";
import {
  reconcileSourceDrafts,
  serializeSourceDrafts,
  type SourceDraft,
} from "#/lib/project-drafts";
import { projectMetadataVersion } from "#/lib/project-metadata";
import {
  assertProjectSourcePaths,
  projectPaths,
  invalidProjectPaths,
} from "#/lib/project-paths";
import { encodeSource, type SourceFiles } from "#/lib/project-source";
import { saveProjectSource } from "#/lib/project-source.functions";
import type { ProjectDetails, ProjectNode } from "#/lib/project.functions";
import { InvalidSourcePathError } from "#/lib/source-path.schema";
import {
  defaultWorkspaceChrome,
  readWorkspaceLayout,
  restoreWorkspaceDock,
  workspaceLayoutKey,
  writeWorkspaceLayout,
  type WorkspaceChrome,
} from "#/lib/workspace-layout";
import { useProjectFiles } from "#/providers/project-files-provider";
import { useSettings } from "#/providers/settings-provider";
import { useAppShortcut } from "#/providers/shortcuts-provider";
import {
  type FileState,
  useWorkspace,
  type Workspace,
  WorkspaceProvider,
} from "#/providers/workspace-provider";

import { AssistantSidebar } from "./assistant-sidebar";
import type { CreateNodeHandle } from "./create-node-form";
import { Editor } from "./editor";
import { GeneratedFile } from "./generated-file";
import {
  MarkdownPreview,
  type MarkdownPreviewParams,
} from "./markdown-preview";
import type { ProjectExportHandle } from "./project-export";
import { ProjectSidebar } from "./project-sidebar";
import type { RepairSourcePathsHandle } from "./repair-source-paths";
import { SidebarResize } from "./sidebar-resize";
import { SourcePdf } from "./source-pdf";
import type { UploadSourceHandle } from "./upload-source";
import { WorkspaceMenu } from "./workspace-menu";
import { WorkspacePresence } from "./workspace-presence";
import { WorkspaceProblems } from "./workspace-problems";

type FilePanelParams = {
  node: ProjectNode;
  preview: boolean;
};
const noProblems: LatexProblem[] = [];
const emptySubscribe = () => () => {};
const noCollaborationStatus = () => undefined;

function FileEditor({
  params,
  api: panelApi,
}: IDockviewPanelProps<FilePanelParams>) {
  const workspace = useWorkspace();
  const editor = useRef<EditorView | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const { registerEditor } = workspace;
  useEffect(() => {
    if (editor.current) registerEditor(params.node.id, editor.current);
    return () => registerEditor(params.node.id, null);
  }, [params.node.id, registerEditor]);
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
  const collaboration = workspace.collaboration.get(params.node.id);
  const status = useSyncExternalStore(
    collaboration?.subscribe ?? emptySubscribe,
    collaboration?.getStatus ?? noCollaborationStatus,
  );
  const draft = workspace.drafts.get(params.node.id);
  const path = workspace.paths.get(params.node.id) ?? params.node.name;
  if (params.node.kind === "binary" && /\.pdf$/i.test(params.node.name))
    return <SourcePdf node={params.node} />;
  if (params.node.kind === "binary")
    return (
      <div className="space-y-3 p-4 text-sm">
        <p className="text-muted-foreground">
          Preview is not available for this file type.
        </p>
        <Button
          variant="ghost"
          disabled={downloading}
          onClick={async () => {
            setDownloadError("");
            setDownloading(true);
            try {
              const response = await fetch(
                `/api/sources/${workspace.projectId}/${params.node.id}`,
              );
              if (!response.ok) throw new Error("Could not download source");
              downloadFile(await response.blob(), params.node.name);
            } catch {
              setDownloadError(
                "The file could not be downloaded. Try again when online.",
              );
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? "Downloading…" : "Download file"}
        </Button>
        {downloadError && (
          <p role="alert" className="text-destructive">
            {downloadError}
          </p>
        )}
      </div>
    );
  if (!collaboration || !status?.ready)
    return (
      <p role="status" className="p-4 text-sm">
        {status?.error || "Connecting to collaboration…"}
      </p>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {(!status.connected || status.error) && (
        <p role="status" className="border-b px-3 py-2 text-xs">
          {status.error || "Offline. Edits will merge when reconnected."}
        </p>
      )}
      <Editor
        onCommands={(run) => workspace.registerCommands(params.node.id, run)}
        onCursorPosition={(position) =>
          workspace.reportCursor(params.node.id, position)
        }
        collaboration={collaboration}
        key={params.node.id}
        readOnly={!workspace.canWrite || !status.canWrite}
        onCreateEditor={(view) => {
          editor.current = view;
          registerEditor(params.node.id, view);
          if (panelApi.isActive) view.focus();
        }}
        filename={params.node.name}
        defaultValue={collaboration.text.toString()}
        savedValue={draft?.savedValue ?? ""}
        allowOpenFile={false}
        completion={workspace.completion}
        problems={workspace.problems.get(path) ?? noProblems}
        onSyntaxProblems={(problems) => workspace.reportSyntax(path, problems)}
        jump={
          workspace.jump?.id === params.node.id ? workspace.jump : undefined
        }
        formatSettings={workspace.formatSettings}
        preamble={
          workspace.symbolPreamble && {
            ...workspace.symbolPreamble,
            addPackage: workspace.addSymbolPackage,
          }
        }
        onRevealPdf={
          workspace.synctex
            ? (line) => workspace.revealPdf(path, line)
            : undefined
        }
        onOpenPreview={() => workspace.openMarkdownPreview(params.node.id)}
      />
    </div>
  );
}

function FileTab(props: IDockviewPanelHeaderProps<{ preview?: boolean }>) {
  const workspace = useWorkspace();
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div />}
        className={cn("h-full", props.params.preview ? "italic" : "not-italic")}
      >
        <DockviewDefaultTab
          {...props}
          onDoubleClick={() => workspace.keepOpen(props.api.id)}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        {props.params.preview && (
          <ContextMenuItem onClick={() => workspace.keepOpen(props.api.id)}>
            Keep open
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={() => workspace.closeTabs(props.api.id, "one")}
        >
          Close
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => workspace.closeTabs(props.api.id, "others")}
        >
          Close others
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => workspace.closeTabs(props.api.id, "all")}
        >
          Close all
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => workspace.closeTabs(props.api.id, "right")}
        >
          Close to the right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const components = {
  editor: FileEditor,
  generated: GeneratedFile,
  markdown: MarkdownPreview,
  problems: WorkspaceProblems,
};
const tabComponents = { file: FileTab };

export function ProjectWorkspace({
  project,
  userId,
}: {
  project: ProjectDetails;
  userId: string;
}) {
  const files = useProjectFiles();
  const fileStatus = useSyncExternalStore(
    files.subscribe,
    files.getStatus,
    files.getStatus,
  );
  const canWrite = fileStatus.canWrite ?? project.canWrite;
  const { id: projectId, name } = project;
  const { data: nodes } = useLiveQuery(files.nodes);
  const api = useRef<DockviewApi | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const previewId = useRef<string | null>(null);
  const drafts = useRef(new Map<string, FileState>());
  const editors = useRef(new Map<string, EditorView>());
  const registerEditor = useCallback((id: string, view: EditorView | null) => {
    if (view) editors.current.set(id, view);
    else editors.current.delete(id);
  }, []);
  const subscriptions = useRef<Array<{ dispose: () => void }>>([]);
  const [activeId, setActiveId] = useState<string>();
  const [ready, setReady] = useState(false);
  const layoutKey = workspaceLayoutKey(userId, projectId);
  const [initialLayout] = useState(() => {
    try {
      return readWorkspaceLayout(localStorage.getItem(layoutKey));
    } catch {
      return { chrome: defaultWorkspaceChrome, dock: undefined };
    }
  });
  const [chrome, setChrome] = useState(initialLayout.chrome);
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;
  const updateChrome = (patch: Partial<WorkspaceChrome>) =>
    setChrome((previous) => {
      const next = { ...previous, ...patch };
      if (window.matchMedia("(max-width: 767px)").matches) {
        if (patch.historyOpen === true) {
          next.rightOpen = false;
          next.agentsOpen = false;
        } else if (patch.agentsOpen === true) {
          next.rightOpen = false;
          next.historyOpen = false;
        } else if (patch.rightOpen === true) {
          next.agentsOpen = false;
          next.historyOpen = false;
        }
      }
      return next;
    });
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 767px)");
    const adapt = () => {
      if (narrow.matches)
        setChrome((previous) =>
          (previous.agentsOpen || previous.historyOpen) && previous.rightOpen
            ? { ...previous, agentsOpen: false, historyOpen: false }
            : previous.agentsOpen && previous.historyOpen
              ? { ...previous, historyOpen: false }
              : previous,
        );
    };
    adapt();
    narrow.addEventListener("change", adapt);
    return () => narrow.removeEventListener("change", adapt);
  }, []);
  const createRef = useRef<CreateNodeHandle | null>(null);
  const uploadRef = useRef<UploadSourceHandle | null>(null);
  const exportRef = useRef<ProjectExportHandle | null>(null);
  const repairRef = useRef<RepairSourcePathsHandle | null>(null);
  const commands = useRef(new Map<string, (command: EditorCommand) => void>());
  const positions = useRef(new Map<string, { line: number; column: number }>());
  const [cursor, setCursor] = useState<{
    id: string;
    line: number;
    column: number;
  }>();
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (ready)
      void gitAction({ data: { projectId, action: { kind: "status" } } })
        .then((result) => {
          if (active) setGitBranch(result.status.branch);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [ready, projectId]);
  const registerCommands = useCallback(
    (id: string, run: ((command: EditorCommand) => void) | null) => {
      if (run) commands.current.set(id, run);
      else commands.current.delete(id);
    },
    [],
  );
  const reportCursor = useCallback(
    (id: string, position: { line: number; column: number }) => {
      positions.current.set(id, position);
      if (api.current?.activePanel?.id === id)
        setCursor((previous) =>
          previous?.id === id &&
          previous.line === position.line &&
          previous.column === position.column
            ? previous
            : { id, ...position },
        );
    },
    [],
  );
  const persistLayout = useCallback(() => {
    if (documentCachingStopped()) return;
    const dock = api.current;
    if (dock) writeWorkspaceLayout(layoutKey, chromeRef.current, dock.toJSON());
  }, [layoutKey]);
  useEffect(() => {
    if (ready) persistLayout();
  }, [chrome, ready, persistLayout]);
  const collaboration = useRef(new Map<string, CollaborativeFile>());
  const [collaborationRevision, setCollaborationRevision] = useState(0);
  const collaborationSnapshot = useMemo(
    () => new Map(collaboration.current),
    [collaborationRevision],
  );
  const observeChange = useRef<(id: string, value: string) => void>(() => {});
  const versions = files.sourceVersions;
  const localDrafts = useRef<Record<string, SourceDraft>>({});
  const [recovery, setRecovery] = useState<Record<string, SourceDraft>>({});
  const [sourceError, setSourceError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInProgress = useRef(false);
  const paths = useMemo(() => projectPaths(nodes), [nodes]);
  const previousPaths = useRef(paths);
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
  const [streamedBuild, setStreamedBuild] = useState<{
    id: string;
    revision: number | undefined;
  } | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState("");
  const [jump, setJump] = useState<Workspace["jump"]>();
  const {
    formatting,
    open: settingsOpen,
    setOpen: setSettingsOpen,
  } = useSettings();
  const formatSettings = formatting ?? { indent: 2, wrap: true, width: 80 };
  const storageKey = `texfolia.project.${projectId}.sources`;
  useEffect(() => {
    const cleared = (event: StorageEvent) => {
      if (
        event.storageArea !== localStorage ||
        event.newValue !== null ||
        (event.key !== storageKey && event.key !== layoutKey)
      )
        return;
      stopDocumentCaching();
      window.location.replace("/");
    };
    window.addEventListener("storage", cleared);
    return () => window.removeEventListener("storage", cleared);
  }, [storageKey, layoutKey]);
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
      if (
        streamedBuild?.id === completed.id &&
        buildMetadata?.current &&
        buildMetadata?.artifacts?.id !== completed.id &&
        (buildMetadata?.artifacts?.revision ?? -1) <=
          (completed.revision ?? Infinity)
      )
        return;
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
      setStreamedBuild(null);
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
          setStreamedBuild(null);
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
  }, [sharedPdfUrl, compiling, buildMetadata, streamedBuild]);
  const stale = sourceChanged || (buildMetadata?.stale ?? false);
  const synctex = useSyncTex({
    projectId,
    build: buildMetadata,
    pdfBuildId:
      streamedBuild?.id ??
      (pdf && sharedPdfUrl && displayedPdfUrl.current === sharedPdfUrl
        ? (buildMetadata?.artifacts?.id ?? null)
        : null),
    paths,
    stale,
  });
  const [pdfJump, setPdfJump] = useState<Workspace["pdfJump"]>(null);
  function revealPdf(path: string, line: number) {
    if (!synctex || !buildMetadata?.artifacts?.pdf) return;
    const location = sourceToPdf(synctex, path, line);
    if (!location) return;
    openGenerated(buildMetadata.artifacts.pdf, true);
    setPdfJump({ index: synctex, location });
  }
  const pdfSaveState =
    !streamedBuild || buildMetadata?.artifacts?.id === streamedBuild.id
      ? "saved"
      : buildMetadata?.current?.id === streamedBuild.id &&
          ["queued", "running"].includes(buildMetadata.current.status)
        ? "saving"
        : "not-saved";
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
  const mainId = [...paths].find(([, path]) => path === main)?.[0];
  const mainDraft = mainId ? drafts.current.get(mainId) : undefined;

  function addSymbolPackage(packageName: string) {
    if (!canWrite || Object.keys(recovery).length || !mainId) return;
    const view = editors.current.get(mainId);
    if (view) {
      addLatexPackage(packageName)(view);
      return;
    }
    const draft = drafts.current.get(mainId);
    if (!draft) return;
    const insertion = packageInsertion(draft.value, packageName);
    if (insertion)
      change(
        mainId,
        draft.value.slice(0, insertion.from) +
          insertion.insert +
          draft.value.slice(insertion.from),
      );
  }

  async function sourceFiles(): Promise<SourceFiles>;
  async function sourceFiles(
    mode: "compile",
  ): Promise<{ sources: CompileSources; metadataVersion: string }>;
  async function sourceFiles(
    mode?: "compile",
  ): Promise<
    SourceFiles | { sources: CompileSources; metadataVersion: string }
  > {
    await files.refresh();
    const nodes = files.nodes.toArray;
    if (mode === "compile") assertProjectSourcePaths(nodes);
    const paths = projectPaths(nodes);
    const snapshotVersions = { ...versions };
    const metadataVersion = await projectMetadataVersion({
      nodes,
      sourceVersions: snapshotVersions,
      textSource: mode === "compile" ? "saved" : "live",
    });
    await synchronizeTextFiles(nodes);
    const saved = mode === "compile";
    const sources: CompileSources = {};
    for (const node of nodes) {
      const path = paths.get(node.id);
      if (node.kind !== "text" || !path) continue;
      const objectKey = snapshotVersions[node.id]?.objectKey;
      const hash = objectKey?.split("/").at(-1);
      sources[path] = saved
        ? hash
          ? { hash }
          : ""
        : (collaboration.current.get(node.id)?.text.toString() ?? "");
    }
    for (const node of nodes) {
      const path = paths.get(node.id);
      if (node.kind !== "binary" || !path) continue;
      if (mode === "compile") {
        const hash = snapshotVersions[node.id]?.objectKey?.split("/").at(-1);
        if (!hash) throw new Error(`Save ${path} before compiling`);
        sources[path] = { hash };
      } else {
        const response = await fetch(`/api/sources/${projectId}/${node.id}`);
        if (!response.ok) throw new Error(`Could not load ${path}`);
        sources[path] = {
          base64: encodeSource(new Uint8Array(await response.arrayBuffer())),
        };
      }
    }
    if (mode === "compile") return { sources, metadataVersion };
    const current = await files.refresh();
    if (
      (await projectMetadataVersion({ ...current, textSource: "live" })) !==
      metadataVersion
    )
      throw new Error(
        "Project files changed during export. Try downloading again.",
      );
    // Export uses live collaborative text; compiled sources use saved hashes.
    const exported: SourceFiles = {};
    for (const [path, source] of Object.entries(sources)) {
      if (typeof source === "string" || "base64" in source)
        exported[path] = source;
    }
    return exported;
  }

  function reconcileTextFiles(nodes: ProjectNode[]) {
    const ids = new Set(
      nodes.filter((node) => node.kind === "text").map((node) => node.id),
    );
    let changed = false;
    for (const id of ids) {
      const existing = collaboration.current.get(id);
      if (existing) {
        existing.refreshAccess(canWrite);
        continue;
      }
      let initialized = false;
      collaboration.current.set(
        id,
        new CollaborativeFile({
          projectId,
          nodeId: id,
          userId,
          canWrite: canWrite,
          onSaved: (saved) => {
            const previous = versions[id];
            if (previous && previous.updatedAt > saved.updatedAt) return;
            versions[id] = {
              objectKey: saved.objectKey,
              updatedAt: saved.updatedAt,
            };
            const value =
              collaboration.current.get(id)?.text.toString() ?? saved.value;
            drafts.current.set(id, { value, savedValue: saved.value });
            const node = files.nodes.get(id);
            if (node)
              api.current
                ?.getPanel(id)
                ?.api.setTitle(
                  `${node.name}${value !== saved.value ? " ●" : ""}`,
                );
            setCollaborationRevision((revision) => revision + 1);
          },
          onChange: (value) => {
            observeChange.current(id, value);
            if (!initialized) {
              initialized = true;
              setCollaborationRevision((revision) => revision + 1);
            }
          },
        }),
      );
      changed = true;
    }
    for (const [id, file] of collaboration.current) {
      if (!files.getStatus().deleted.has(id)) continue;
      // Keep deleted documents and their panels available for copying/recovery.
      // Retiring stops reconnects without discarding the IndexedDB document.
      file.retire();
    }
    if (changed) setCollaborationRevision((value) => value + 1);
  }

  async function synchronizeTextFiles(nodes: ProjectNode[]) {
    reconcileTextFiles(nodes);
    await Promise.all(
      nodes
        .filter((node) => node.kind === "text")
        .map(async (node) => {
          const file = collaboration.current.get(node.id);
          if (!file) throw new Error("Could not synchronize project files");
          await file.whenConnected();
        }),
    );
  }

  useEffect(() => {
    if (ready) reconcileTextFiles(nodes);
  }, [ready, nodes, projectId, canWrite, userId, fileStatus.deleted]);

  useEffect(() => {
    if (!ready) return;
    for (const node of nodes) {
      const path = paths.get(node.id);
      if (!path || previousPaths.current.get(node.id) === path) continue;
      const draft = drafts.current.get(node.id);
      if (draft) update(path, draft.value);
      const panel = api.current?.getPanel(node.id);
      panel?.api.updateParameters({ node });
      panel?.api.setTitle(
        `${node.name}${draft && draft.value !== draft.savedValue ? " ●" : ""}`,
      );
      api.current
        ?.getPanel(`markdown:${node.id}`)
        ?.api.setTitle(`Preview: ${node.name}`);
    }
    previousPaths.current = paths;
  }, [nodes, paths, ready, update]);

  useEffect(
    () => () => {
      for (const file of collaboration.current.values()) file.destroy();
      collaboration.current.clear();
    },
    [],
  );

  function cacheDrafts() {
    if (documentCachingStopped()) return;
    try {
      localStorage.setItem(
        storageKey,
        serializeSourceDrafts(localDrafts.current),
      );
    } catch {
      setSourceError(
        "Offline drafts could not be cached. Save to the server before closing this page.",
      );
    }
  }

  async function saveSources() {
    if (
      !canWrite ||
      !ready ||
      Object.keys(recovery).length ||
      saveInProgress.current
    )
      return false;
    saveInProgress.current = true;
    setSaving(true);
    setSourceError("");
    try {
      const metadata = await files.refresh();
      if (!metadata.canWrite)
        throw new Error("Viewers cannot save project files");
      const nodes = files.nodes.toArray;
      await synchronizeTextFiles(nodes);
      for (const node of nodes) {
        if (node.kind !== "text") continue;
        const file = collaboration.current.get(node.id);
        if (!file)
          throw new Error("Wait for collaboration to connect before saving.");
        const saved = await file.save();
        versions[node.id] = {
          objectKey: saved.objectKey,
          updatedAt: saved.updatedAt,
        };
        const value = file.text.toString();
        drafts.current.set(node.id, { value, savedValue: saved.value });
        if (value === saved.value) delete localDrafts.current[node.id];
        api.current
          ?.getPanel(node.id)
          ?.api.setTitle(`${node.name}${value !== saved.value ? " ●" : ""}`);
      }
      cacheDrafts();
      return true;
    } catch (error) {
      setSourceError(
        error instanceof Error
          ? error.message
          : "Sources could not be saved. Your local draft is still available.",
      );
      return false;
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  }

  async function compileProject(clean = false) {
    const snapshot = revision.current;
    const events = buildEvents.current;
    if (!main || !events || !canWrite || !(await saveSources())) return;
    compilation.current?.abort();
    const startedAt = performance.now();
    const editedAt = lastEditAt.current;
    const controller = new AbortController();
    compilation.current = controller;
    setCompiling(true);
    setCompileError("");
    setCompileProblems([]);
    const sequence = ++editSequence.current;
    clearTimeout(notification.current);
    try {
      const { sources, metadataVersion } = await sourceFiles("compile");
      const result = await requestCompilation({
        projectId,
        events,
        clean,
        editorVersion: { editorId: editorId.current, sequence },
        startedAt,
        lastEditAt: editedAt,
        mainFile: main,
        files: sources,
        metadataVersion,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10 * 60_000),
        ]),
        onPreview: ({ pdf, jobId, revision }) => {
          if (controller.signal.aborted) return;
          const latest = sharedBuild.current;
          if (
            latest?.current?.id !== jobId &&
            (revision === undefined ||
              (latest?.current?.revision ?? -1) > revision)
          )
            return;
          const build = { id: jobId, revision };
          completedJob.current = build;
          setStreamedBuild(build);
          setPdf(pdf);
        },
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
        if (diagnostics.length) openProblems();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setCompileError(
        error instanceof DOMException && error.name === "TimeoutError"
          ? "The compile job is taking longer than expected. Try again in a few minutes."
          : error instanceof InvalidSourcePathError
            ? error.message
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

  useAppShortcut("save", () => void saveSources(), {
    target: container,
    enabled: !settingsOpen,
  });
  useAppShortcut("nextTab", () => cycleTab(1), {
    target: container,
    enabled: !settingsOpen,
  });
  useAppShortcut("previousTab", () => cycleTab(-1), {
    target: container,
    enabled: !settingsOpen,
  });
  useAppShortcut(
    "sidebar",
    () => updateChrome({ rightOpen: !chrome.rightOpen }),
    { target: container, enabled: !settingsOpen },
  );

  useEffect(
    () => () => {
      api.current = null;
      subscriptions.current.forEach((subscription) => subscription.dispose());
    },
    [],
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (documentCachingStopped()) return;
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

  function change(id: string, value: string) {
    if (!canWrite) return;
    const file = collaboration.current.get(id);
    if (file) file.replace(value);
  }

  observeChange.current = (id, value) => {
    const previous = drafts.current.get(id) ?? { value: "", savedValue: "" };
    const savedValue = previous.savedValue;
    drafts.current.set(id, { value, savedValue });

    api.current
      ?.getPanel(`markdown:${id}`)
      ?.api.updateParameters({ source: value });
    const path = paths.get(id);
    if (path && previous.value !== value) {
      lastEditAt.current = performance.now();
      setSourceChanged(true);
      if (canWrite) notifySourceEdit();
      update(path, value);
      setCompileProblems((current) => (current.length ? [] : current));
    }
    keepOpen(id);
    const panel = api.current?.getPanel(id);
    const node = nodes.find((node) => node.id === id);
    if (node)
      panel?.api.setTitle(`${node.name}${value !== savedValue ? " ●" : ""}`);
  };

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
    const created = files.createdTextSources.get(node.id);
    if (created !== undefined) {
      drafts.current.set(node.id, {
        value: created,
        savedValue: created,
      });
      files.createdTextSources.delete(node.id);
      const path =
        paths.get(node.id) ??
        projectPaths([
          ...nodes.filter((existing) => existing.id !== node.id),
          node,
        ]).get(node.id);
      if (path) update(path, created);
    }
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

  function openGenerated(path: string, permanent = false) {
    const dock = api.current;
    if (!dock) return;
    const id = `out:${path}`;
    const existing = dock.getPanel(id);
    if (existing) {
      if (permanent) keepOpen(id);
      existing.api.setActive();
      return;
    }
    const preview = previewId.current
      ? dock.getPanel(previewId.current)
      : undefined;
    const reference =
      preview ??
      dock.panels.find(
        (panel) =>
          panel.api.component === "editor" ||
          panel.api.component === "generated",
      );
    dock.addPanel({
      id,
      component: "generated",
      tabComponent: "file",
      title: path.split("/").at(-1) ?? path,
      params: { path, preview: !permanent },
      position: reference
        ? { referencePanel: reference.id, direction: "within" }
        : undefined,
    });
    if (!permanent) {
      previewId.current = id;
      if (preview) dock.removePanel(preview);
    }
  }

  function reveal(path: string, line = 1) {
    const node = nodes.find((node) => paths.get(node.id) === path);
    if (!node) return;
    openFile(node, true);
    setJump({ id: node.id, line });
  }
  function closeTabs(id: string, mode: "one" | "others" | "all" | "right") {
    const dock = api.current;
    const panel = dock?.getPanel(id);
    if (!dock || !panel) return;
    const group = [...panel.group.panels];
    const index = group.findIndex((panel) => panel.id === id);
    const targets =
      mode === "all"
        ? group
        : mode === "others"
          ? group.filter((panel) => panel.id !== id)
          : mode === "right"
            ? group.slice(index + 1)
            : [panel];
    for (const target of targets) {
      dock.removePanel(target);
    }
  }
  function openProblems() {
    const dock = api.current;
    if (!dock) return;
    const existing = dock.getPanel("problems");
    if (existing) {
      existing.api.setActive();
      return;
    }
    const reference = dock.activePanel ?? dock.panels[0];
    dock.addPanel({
      id: "problems",
      component: "problems",
      title: "Problems",
      initialHeight: 180,
      position: reference
        ? { referencePanel: reference.id, direction: "below" }
        : undefined,
    });
  }

  async function onReady({ api: dock }: DockviewReadyEvent) {
    api.current = dock;
    for (const [id, value] of Object.entries(project.sourceContents)) {
      drafts.current.set(id, { value, savedValue: value });
      const path = paths.get(id);
      if (path) update(path, value);
    }
    try {
      const { migrate, recover } = reconcileSourceDrafts({
        raw: localStorage.getItem(storageKey),
        contents: project.sourceContents,
        versions: project.sourceVersions,
      });
      localDrafts.current = { ...migrate, ...recover };
      for (const [id, draft] of Object.entries(migrate)) {
        if (api.current !== dock) return;
        if (!canWrite) {
          recover[id] = draft;
          continue;
        }
        try {
          const version = await saveProjectSource({
            data: {
              projectId,
              nodeId: id,
              expectedObjectKey: null,
              content: encodeSource(new TextEncoder().encode(draft.value)),
            },
          });
          versions[id] = version;
          drafts.current.set(id, {
            value: draft.value,
            savedValue: draft.value,
          });
          const path = paths.get(id);
          if (path) update(path, draft.value);
          delete localDrafts.current[id];
        } catch {
          recover[id] = draft;
          setSourceError(
            "Some browser drafts could not be migrated. Recover them below and save when online.",
          );
        }
      }
      if (api.current !== dock) return;
      setRecovery(recover);
      cacheDrafts();
    } catch {
      setSourceError(
        "Browser drafts could not be read. The server copy is open; the original browser cache has not been changed.",
      );
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
        if (panel) {
          const position = positions.current.get(panel.id);
          setCursor(position ? { id: panel.id, ...position } : undefined);
        }
      }),
      dock.onDidLayoutChange(persistLayout),
      dock.onDidRemovePanel((panel) => {
        if (previewId.current === panel.id) previewId.current = null;
        setActiveId((previous) =>
          previous === panel.id ? undefined : previous,
        );
      }),
    ];
    const first =
      nodes.find((node) => node.kind === "text" && node.name === "main.tex") ??
      nodes.find((node) => node.kind === "text");
    if (!restoreWorkspaceDock(dock, initialLayout.dock, nodes)) {
      if (first) openFile(first, true);
      if (first) dock.getPanel(first.id)?.api.setActive();
    }
    for (const panel of dock.panels) {
      if (panel.api.component === "markdown")
        panel.api.updateParameters({
          source:
            drafts.current.get(panel.id.slice("markdown:".length))?.value ?? "",
        });
      if (panel.params?.preview === true) {
        if (previewId.current)
          dock
            .getPanel(previewId.current)
            ?.api.updateParameters({ preview: false });
        previewId.current = panel.id;
      }
    }
    setReady(true);
  }

  const compileStatus =
    compiling ||
    ["queued", "running"].includes(buildMetadata?.current?.status ?? "")
      ? "Compiling…"
      : compileError || buildMetadata?.current?.status === "failed"
        ? "Compile failed"
        : stale
          ? "Out of date"
          : pdf
            ? "Up to date"
            : "Not compiled";
  return (
    <WorkspaceProvider
      value={{
        collaboration: collaborationSnapshot,
        projectId,
        canWrite: canWrite && Object.keys(recovery).length === 0,
        build: buildMetadata,
        stale,
        drafts: drafts.current,
        keepOpen,
        openMarkdownPreview,
        change,
        registerEditor,
        symbolPreamble:
          main && mainDraft
            ? { source: mainDraft.value, filename: main }
            : undefined,
        addSymbolPackage,
        paths,
        completion,
        problems,
        allProblems,
        reveal,
        closeTabs,
        reportGitBranch: setGitBranch,
        registerCommands,
        reportCursor,
        reportSyntax,
        jump,
        pdf,
        synctex,
        pdfJump,
        revealPdf,
        pdfSaveState,
        formatSettings,
      }}
    >
      <SidebarProvider
        keyboardShortcut={false}
        ref={container}
        className={cn(
          "h-svh min-h-0 flex-col overflow-hidden [--workspace-footer-height:2rem] [--workspace-header-height:2.5rem] **:data-[slot=sidebar-container]:transition-none **:data-[slot=sidebar-gap]:transition-none [&_[data-slot=sidebar-footer]]:p-0 [&_[data-slot=sidebar-group]]:p-0 [&_[data-slot=sidebar-menu]]:gap-0",
        )}
      >
        <SettingsDialog />
        <WorkspaceMenu
          name={name}
          canWrite={canWrite && ready && Object.keys(recovery).length === 0}
          saving={saving}
          compiling={compiling}
          compileAvailable={!!main}
          editorAvailable={nodes.some(
            (node) => node.id === activeId && node.kind === "text",
          )}
          onSave={() => void saveSources()}
          onCompile={(clean) => void compileProject(clean)}
          onCreate={(kind) => createRef.current?.start(kind)}
          onUpload={() => uploadRef.current?.open()}
          onExport={() => exportRef.current?.open()}
          onRepair={
            invalidProjectPaths(nodes).length
              ? () => repairRef.current?.open()
              : undefined
          }
          onSettings={() => setSettingsOpen(true)}
          onEditor={(command) => {
            if (activeId) commands.current.get(activeId)?.(command);
          }}
          chrome={chrome}
          onChrome={updateChrome}
          onProblems={openProblems}
        />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div
            hidden={!chrome.agentsOpen && !chrome.historyOpen}
            style={{
              width:
                (chrome.agentsOpen ? chrome.agentsWidth : 0) +
                (chrome.historyOpen
                  ? chrome.historyWidth + (chrome.agentsOpen ? 4 : 0)
                  : 0),
            }}
            className="z-30 h-full min-w-0 shrink-0 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:max-w-[85%] [&[hidden]]:hidden"
          >
            <AssistantSidebar
              projectId={projectId}
              open={chrome.agentsOpen}
              onClose={() => updateChrome({ agentsOpen: false })}
              historyOpen={chrome.historyOpen}
              historyWidth={chrome.historyWidth}
              agentsWidth={chrome.agentsWidth}
              onHistoryToggle={() =>
                updateChrome({ historyOpen: !chrome.historyOpen })
              }
              onHistoryResize={(historyWidth) => updateChrome({ historyWidth })}
              onShowAgents={() => updateChrome({ agentsOpen: true })}
            />
          </div>
          {(chrome.agentsOpen || chrome.historyOpen) && (
            <SidebarResize
              side="left"
              width={
                chrome.agentsOpen ? chrome.agentsWidth : chrome.historyWidth
              }
              label={
                chrome.agentsOpen
                  ? "Resize agents sidebar"
                  : "Resize history sidebar"
              }
              onResize={(width) =>
                updateChrome(
                  chrome.agentsOpen
                    ? { agentsWidth: width }
                    : { historyWidth: width },
                )
              }
            />
          )}
          <main className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {!ready && (
              <p role="status" className="border-b px-3 py-2 text-sm">
                Loading server sources and checking browser drafts…
              </p>
            )}
            {(sourceError || fileStatus.error) && (
              <p
                role="alert"
                className="text-destructive border-b px-3 py-2 text-sm wrap-anywhere"
              >
                {sourceError || fileStatus.error}
              </p>
            )}
            {Object.keys(recovery).length > 0 && (
              <div
                className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm"
                role="status"
              >
                <span>
                  Unsaved browser drafts are available for{" "}
                  {Object.keys(recovery).length} file(s). The server copy is
                  open.
                </span>
                <Button
                  size="sm"
                  disabled={
                    !canWrite ||
                    Object.keys(recovery).some(
                      (id) => !collaboration.current.get(id)?.getStatus().ready,
                    )
                  }
                  onClick={() => {
                    for (const [id, draft] of Object.entries(recovery)) {
                      change(id, draft.value);
                      delete localDrafts.current[id];
                    }
                    cacheDrafts();
                    setRecovery({});
                  }}
                >
                  Recover drafts
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    downloadFile(
                      new Blob([serializeSourceDrafts(recovery)], {
                        type: "application/json",
                      }),
                      `${name}-browser-drafts.json`,
                    );
                  }}
                >
                  Download drafts
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    for (const id of Object.keys(recovery))
                      delete localDrafts.current[id];
                    cacheDrafts();
                    setRecovery({});
                  }}
                >
                  Keep server copy
                </Button>
              </div>
            )}
            {compileError && (
              <p
                role="alert"
                className="text-destructive border-b px-3 py-2 text-sm wrap-anywhere"
              >
                {compileError}
              </p>
            )}
            <div className="min-h-0 flex-1">
              <ClientOnly>
                <DockviewReact
                  className="isolate size-full"
                  theme={{
                    name: "texfolia",
                    className: "dockview-theme-texfolia",
                  }}
                  components={components}
                  tabComponents={tabComponents}
                  defaultTabComponent={FileTab}
                  onReady={onReady}
                />
              </ClientOnly>
            </div>
          </main>
          {chrome.rightOpen && (
            <SidebarResize
              side="right"
              width={chrome.rightWidth}
              onResize={(rightWidth) => updateChrome({ rightWidth })}
            />
          )}
          <div
            hidden={!chrome.rightOpen}
            style={{ width: chrome.rightWidth }}
            className="z-30 h-full min-w-0 shrink-0 max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:max-w-[85%] [&[hidden]]:hidden"
          >
            <ProjectSidebar
              name={name}
              nodes={nodes}
              activeId={activeId}
              ready={ready}
              onOpen={openFile}
              onOpenGenerated={openGenerated}
              sources={sourceFiles}
              view={chrome.rightView}
              onClose={() => updateChrome({ rightOpen: false })}
              createRef={createRef}
              uploadRef={uploadRef}
              exportRef={exportRef}
              repairRef={repairRef}
              outline={projectOutline(
                new Map(
                  [...paths].flatMap(([id, path]) => {
                    const draft = drafts.current.get(id);
                    return draft ? [[path, draft.value]] : [];
                  }),
                ),
                main,
              )}
            />
          </div>
        </div>
        <footer
          aria-label="Workspace status"
          className="z-20 flex h-8 shrink-0 items-center gap-1 border-t bg-(--status-background) px-1 text-xs text-(--status-foreground)"
        >
          <Button
            variant="ghost"
            size="icon-xs"
            className="aria-pressed:bg-muted"
            aria-label="Toggle chat history"
            title="Chat history"
            aria-pressed={chrome.historyOpen}
            onClick={() => updateChrome({ historyOpen: !chrome.historyOpen })}
          >
            <IconHistory />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="aria-pressed:bg-muted"
            aria-label="Toggle agents sidebar"
            aria-pressed={chrome.agentsOpen}
            onClick={() => updateChrome({ agentsOpen: !chrome.agentsOpen })}
          >
            <IconLayoutSidebarLeftExpand />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Problems (${allProblems.length})`}
            onClick={openProblems}
          >
            <IconAlertCircle />
            <span className="max-sm:hidden">Problems</span> (
            {allProblems.length})
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={
              !main ||
              !canWrite ||
              !ready ||
              saving ||
              Object.keys(recovery).length > 0
            }
            onClick={() => void compileProject()}
            aria-label="Compile status"
            title={compileStatus}
          >
            {compileStatus === "Compiling…" ? (
              <IconLoader2 className="motion-safe:animate-spin" />
            ) : compileStatus === "Up to date" ? (
              <IconCircleCheck />
            ) : compileStatus === "Compile failed" ? (
              <IconAlertCircle />
            ) : (
              <IconPlayerPlay />
            )}
            <span className="max-sm:hidden">{compileStatus}</span>
          </Button>
          <WorkspacePresence
            onClick={() =>
              updateChrome({ rightOpen: true, rightView: "collaboration" })
            }
          />
          {gitBranch && (
            <Button
              variant="ghost"
              size="xs"
              className="max-sm:hidden"
              onClick={() =>
                updateChrome({ rightOpen: true, rightView: "git" })
              }
            >
              <IconGitBranch />
              {gitBranch}
            </Button>
          )}
          <span className="min-w-0 flex-1 truncate px-2 text-right max-sm:hidden">
            {activeId?.startsWith("out:")
              ? `out/${activeId.slice(4)}`
              : activeId
                ? paths.get(activeId)
                : "LaTeX workspace"}
          </span>
          {cursor && (
            <span className="shrink-0 px-2 tabular-nums">
              <span className="max-sm:hidden">
                Ln {cursor.line}, Col {cursor.column}
              </span>
              <span className="sm:hidden">
                {cursor.line}:{cursor.column}
              </span>
            </span>
          )}
          <div
            role="toolbar"
            aria-label="Right sidebar views"
            className="ml-auto flex shrink-0 items-center gap-0.5"
          >
            {(
              [
                { view: "files", label: "Files", icon: IconFiles },
                { view: "outline", label: "Outline", icon: IconListTree },
                { view: "git", label: "Git", icon: IconGitBranch },
                {
                  view: "collaboration",
                  label: "Collaboration",
                  icon: IconUsers,
                },
              ] satisfies {
                view: WorkspaceChrome["rightView"];
                label: string;
                icon: typeof IconFiles;
              }[]
            ).map(({ view, label, icon: Icon }) => (
              <Button
                key={view}
                variant="ghost"
                size="icon-xs"
                className="aria-pressed:bg-muted"
                aria-label={label}
                title={label}
                aria-controls="project-sidebar"
                aria-pressed={chrome.rightOpen && chrome.rightView === view}
                onClick={() =>
                  updateChrome({
                    rightView: view,
                    rightOpen: !(chrome.rightOpen && chrome.rightView === view),
                  })
                }
              >
                <Icon />
              </Button>
            ))}
          </div>
        </footer>
      </SidebarProvider>
    </WorkspaceProvider>
  );
}
