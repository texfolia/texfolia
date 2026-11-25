import { useLiveQuery } from "@tanstack/react-db";
import { ClientOnly } from "@tanstack/react-router";

import "dockview-react/dist/styles/dockview.css";
import { SidebarProvider } from "@texfolia/ui/sidebar";
import { cn } from "cn";
import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { lazyPanel } from "#/components/lazy-panel";
import { useComments } from "#/hooks/use-comments";
import { useHasBeen } from "#/hooks/use-has-been";
import { useLatexAnalysis } from "#/hooks/use-latex-analysis";
import {
  useStableActions,
  useStableCallback,
} from "#/hooks/use-stable-callback";
import { useStableValue } from "#/hooks/use-stable-value";
import { useSyncTex } from "#/hooks/use-synctex";
import { selectionPrompt } from "#/lib/ai/editor";
import { scratchpadId } from "#/lib/collaboration";
import type { EditorCommand } from "#/lib/editor/editor-command";
import { entryAppendix, newBibFile } from "#/lib/editor/latex/bibtex";
import { latexCompletion } from "#/lib/editor/latex/completion";
import { addLatexPackage, packageInsertion } from "#/lib/editor/latex/symbols";
import { sourceToPdf } from "#/lib/editor/latex/synctex";
import { selectedLines } from "#/lib/editor/selection";
import { createStore } from "#/lib/external-store";
import {
  invalidProjectPaths,
  isMainFileCandidate,
  projectMainFile,
  projectPaths,
} from "#/lib/projects";
import type { ProjectDetails } from "#/lib/projects/project.functions";
import { encodeSource } from "#/lib/storage";
import { FileDrafts } from "#/lib/workspace/file-drafts";
import {
  type PanelView,
  type SidebarView,
  workspaceLayoutKey,
} from "#/lib/workspace/workspace-layout";
import { useProjectFiles } from "#/providers/project-files-provider";
import { useSettings } from "#/providers/settings-provider";
import {
  type Workspace,
  type WorkspaceActions,
  type WorkspaceBuild,
  type WorkspaceDiagnostics,
  WorkspaceProvider,
} from "#/providers/workspace-provider";

import { useCollaborationFiles } from "../-hooks/use-collaboration-files";
import { useCompilation } from "../-hooks/use-compilation";
import { scratchpadTitle, useDockPanels } from "../-hooks/use-dock-panels";
import { useSavedSources } from "../-hooks/use-saved-sources";
import { useScratchpad } from "../-hooks/use-scratchpad";
import { sourceDraftsKey, useSourceSave } from "../-hooks/use-source-save";
import { useWorkspaceChrome } from "../-hooks/use-workspace-chrome";
import { useWorkspaceProblems } from "../-hooks/use-workspace-problems";
import {
  useExitWhenStorageCleared,
  useGitBranch,
} from "../-hooks/use-workspace-session";
import { useWorkspaceShortcuts } from "../-hooks/use-workspace-shortcuts";
import type { AddReferenceRequest } from "./add-reference-dialog";
import type { CreateNodeHandle } from "./create-node-form";
import { dockComponents, dockTabComponents, FileTab } from "./dock-panels";
import { DraftRecovery } from "./draft-recovery";
import type { ProjectExportHandle } from "./project-export";
import type { SearchRequest } from "./project-search";
import { ProjectSidebar } from "./project-sidebar";
import type { RepairSourcePathsHandle } from "./repair-source-paths";
import { SidebarResize } from "./sidebar-resize";
import type { UploadSourceHandle } from "./upload-source";
import { WorkspaceAgentsSidebar } from "./workspace-agents-sidebar";
import { WorkspaceMenu } from "./workspace-menu";
import type {
  PaletteFile,
  PaletteMode,
  WorkspaceCommand,
} from "./workspace-palette";
import { WorkspaceStatusBar } from "./workspace-status-bar";

const SettingsDialog = lazyPanel("Settings", async () => {
  const { SettingsDialog } = await import("#/components/settings-dialog");
  return SettingsDialog;
});
const AddReferenceDialog = lazyPanel("Add reference", async () => {
  const { AddReferenceDialog } = await import("./add-reference-dialog");
  return AddReferenceDialog;
});
const WorkspacePalette = lazyPanel("Go to file", async () => {
  const { WorkspacePalette } = await import("./workspace-palette");
  return WorkspacePalette;
});
const WorkspacePanel = lazyPanel("This panel", async () => {
  const { WorkspacePanel } = await import("./workspace-panel");
  return WorkspacePanel;
});

const defaultFormatSettings = { indent: 2, wrap: true, width: 80 };
const dockTheme = { name: "texfolia", className: "dockview-theme-texfolia" };

function samePaths(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
) {
  if (a.size !== b.size) return false;
  const other = b.entries();
  for (const [id, path] of a) {
    const entry = other.next().value;
    if (entry?.[0] !== id || entry[1] !== path) return false;
  }
  return true;
}

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
  const container = useRef<HTMLDivElement>(null);
  const createRef = useRef<CreateNodeHandle | null>(null);
  const uploadRef = useRef<UploadSourceHandle | null>(null);
  const exportRef = useRef<ProjectExportHandle | null>(null);
  const repairRef = useRef<RepairSourcePathsHandle | null>(null);
  // Each file's live and saved text, shared with the editors by reference.
  const [drafts] = useState(() => new FileDrafts());
  const [ready, setReady] = useState(false);
  const layoutKey = workspaceLayoutKey(userId, projectId);
  useExitWhenStorageCleared([sourceDraftsKey(projectId), layoutKey]);
  const git = useGitBranch(projectId, ready);
  const {
    formatting,
    compile: compileSettings,
    open: settingsOpen,
    setOpen: setSettingsOpen,
  } = useSettings();

  // Nodes are new objects after each refresh; their paths rarely change.
  const paths = useStableValue(
    useMemo(() => projectPaths(nodes), [nodes]),
    samePaths,
  );
  const filenames = useMemo(() => [...paths.values()], [paths]);
  const mainFile = useMemo(
    () => projectMainFile(paths, fileStatus.mainFile),
    [paths, fileStatus.mainFile],
  );
  const main = mainFile?.path;
  const mainId = mainFile?.id;
  const { result, update, revision } = useLatexAnalysis(filenames, main);
  const readAnalysis = useStableCallback(() => result.analysis);
  const completion = useMemo(
    () => latexCompletion(readAnalysis, filenames),
    [readAnalysis, filenames],
  );

  const panels = useDockPanels({
    files,
    nodes,
    paths,
    drafts,
    ready,
    mainId,
    updateAnalysis: update,
  });
  // The route remounts per project, so this marks when this editor opened.
  const [openedAt] = useState(() => performance.now());
  const { chrome, updateChrome, togglePanel, persistLayout, initialDock } =
    useWorkspaceChrome({ layoutKey, dock: panels.api, ready });
  const collaboration = useCollaborationFiles({
    projectId,
    userId,
    canWrite,
    ready,
    nodes,
    deleted: fileStatus.deleted,
    onSaved: (id, saved, file) =>
      sources.recordSaved(id, saved, file.text.toString()),
    onChange: observeChange,
    onClose: (id, file) => savedSources.keep(id, file),
  });
  const savedSources = useSavedSources({
    project,
    ready,
    files,
    collaboration,
    drafts,
    onLoaded: (id, value) => {
      const path = paths.get(id);
      if (path) update(path, value);
      panels.refreshTitle(id);
    },
  });
  const sources = useSourceSave({
    project,
    canWrite,
    ready,
    files,
    collaboration,
    drafts,
    refreshSaved: savedSources.refresh,
    refreshTitle: panels.refreshTitle,
  });
  const scratchpad = useScratchpad({
    projectId,
    userId,
    canWrite,
    ready,
    onChange: panels.showScratchpad,
  });
  // Drafts are recovered into live documents.
  const { hold } = collaboration;
  const { hold: holdScratchpad } = scratchpad;
  const holdDocument = useCallback(
    (id: string) => (id === scratchpadId ? holdScratchpad(id) : hold(id)),
    [hold, holdScratchpad],
  );
  const { recovery } = sources;
  useEffect(() => {
    const releases = Object.keys(recovery).map(hold);
    return () => releases.forEach((release) => release());
  }, [recovery, hold]);
  const writable = canWrite && !sources.recovering;
  const compilation = useCompilation({
    projectId,
    canWrite,
    main,
    filenames,
    nodes,
    blocked: sources.recovering,
    revision,
    afterIdle: compileSettings.afterIdle,
    saveSources: sources.saveSources,
    saveInProgress: sources.saveInProgress,
    sourceFiles: () => sources.sourceFiles("compile"),
  });
  const { problems, allProblems, reportSyntax } = useWorkspaceProblems({
    analysis: result.analysis.problems,
    compile: compilation.compileProblems,
    filenames,
  });
  const comments = useComments({
    projectId,
    onShow: () => updateChrome({ rightOpen: true, rightView: "comments" }),
  });
  const synctex = useSyncTex({
    projectId,
    build: compilation.build,
    pdfBuildId: compilation.pdfBuildId,
    paths,
    stale: compilation.stale,
  });
  const [pdfJump, setPdfJump] = useState<WorkspaceBuild["pdfJump"]>(null);
  const [searchRequest, setSearchRequest] = useState<SearchRequest>({
    sequence: 0,
  });
  const [referenceRequest, setReferenceRequest] =
    useState<AddReferenceRequest | null>(null);
  const [palette, setPalette] = useState<{
    mode: PaletteMode;
    sequence: number;
  } | null>(null);
  const paletteUsed = useHasBeen(!!palette);
  const [actionError, setActionError] = useState("");
  const { activeId } = panels;
  // Dialogs stay mounted once used, so that they can animate closed.
  const settingsUsed = useHasBeen(settingsOpen);
  const referencesUsed = useHasBeen(!!referenceRequest);
  const bibFiles = useMemo(
    () =>
      [...paths]
        .filter(([, path]) => /\.bib$/i.test(path))
        .map(([id, path]) => ({ id, path }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [paths],
  );

  function observeChange(id: string, value: string, local?: boolean) {
    const previous = drafts.get(id) ?? { value: "", savedValue: "" };
    drafts.set(id, { value, savedValue: previous.savedValue });
    panels.showMarkdownSource(id, value);
    const path = paths.get(id);
    if (path && previous.value !== value) {
      compilation.recordEdit(local);
      update(path, value);
    }
    // Opening a preview tab also reports its text; only edits keep it open.
    if (local) panels.keepOpen(id);
    panels.refreshTitle(id);
  }

  function addSymbolPackage(packageName: string) {
    if (!writable || !mainId) return;
    const view = panels.editor(mainId);
    if (view) {
      addLatexPackage(packageName)(view);
      return;
    }
    collaboration
      .edit(mainId, (file) => {
        const value = file.text.toString();
        const insertion = packageInsertion(value, packageName);
        if (insertion)
          file.replace(
            value.slice(0, insertion.from) +
              insertion.insert +
              value.slice(insertion.from),
          );
      })
      .catch((error: unknown) =>
        console.error("Package was not added", { packageName, error }),
      );
  }

  /** Opens Add reference, offering to cite at the cursor of a LaTeX tab. */
  function addReference(key?: string) {
    if (!writable) return;
    const view = panels.activeEditor();
    const path = panels.activeId ? paths.get(panels.activeId) : undefined;
    setReferenceRequest({
      key,
      cite:
        view && path && /\.(?:tex|ltx)$/i.test(path)
          ? {
              path,
              insert: (citation) => {
                if (!view.dom.isConnected) return;
                view.dispatch(
                  view.state.replaceSelection(`\\cite{${citation}}`),
                );
                view.focus();
              },
            }
          : undefined,
    });
  }

  function readBib(id: string) {
    return (
      collaboration.get(id)?.text.toString() ?? drafts.get(id)?.value ?? ""
    );
  }

  function appendBib(id: string, entry: string) {
    return collaboration.edit(id, (file) => {
      const value = file.text.toString();
      file.replace(value + entryAppendix(value, entry));
    });
  }

  async function createBib(content: string) {
    const root = nodes.find(
      (node) => node.kind === "folder" && node.parentId === null,
    );
    if (!root) throw new Error("This project has no root folder.");
    await files.create({
      kind: "text",
      parentId: root.id,
      name: newBibFile,
      content: encodeSource(new TextEncoder().encode(content)),
    });
  }

  function revealPdf(path: string, line: number) {
    const pdfPath = compilation.build?.artifacts?.pdf;
    if (!synctex || !pdfPath) return;
    const location = sourceToPdf(synctex, path, line);
    if (!location) return;
    panels.openGenerated(pdfPath, true);
    setPdfJump({ index: synctex, location });
  }

  function openSearch() {
    // Seed the query from a single-line selection, like VS Code's Find in Files.
    const view = panels.activeEditor();
    const selection = view?.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    );
    updateChrome({ rightOpen: true, rightView: "search" });
    setSearchRequest((previous) => ({
      sequence: previous.sequence + 1,
      query: selection && !/[\r\n]/.test(selection) ? selection : undefined,
    }));
  }

  // Kept outside React until a chat takes it.
  const [assistantPrompt] = useState(() => createStore<string | null>(null));
  function askAi(prompt: string) {
    updateChrome({ agentsOpen: true });
    assistantPrompt.set(prompt);
  }
  function askAboutSelection() {
    const view = panels.activeEditor();
    const path = activeId ? paths.get(activeId) : undefined;
    if (view && path) askAi(selectionPrompt(path, selectedLines(view.state)));
  }

  const activePath = activeId ? paths.get(activeId) : undefined;
  const canSetMain =
    writable &&
    !!activePath &&
    activePath !== main &&
    isMainFileCandidate(activePath);
  async function setMain() {
    if (!activePath) return;
    setActionError("");
    try {
      await files.setMainFile(activePath);
    } catch (failure) {
      setActionError(
        failure instanceof Error
          ? failure.message
          : "The main document could not be changed. Try again.",
      );
    }
  }

  const paletteSequence = useRef(0);
  function openPalette(mode: PaletteMode) {
    setPalette({ mode, sequence: ++paletteSequence.current });
  }

  /** Every file, the last ones used first, except for the one on screen. */
  function paletteFiles(): PaletteFile[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const entries = [...paths].flatMap(([id, path]) => {
      const node = byId.get(id);
      return node ? [{ id, path, node }] : [];
    });
    const listed = [
      ...entries
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(({ id, path, node }) => ({
          id,
          path,
          open(line?: number, column?: number) {
            if (line && node.kind === "text") panels.reveal(path, line, column);
            else panels.openFile(node, true);
          },
        })),
      ...(compilation.build?.artifacts?.files ?? []).map(({ path }) => ({
        id: `out:${path}`,
        path: `out/${path}`,
        open: () => panels.openGenerated(path, true),
      })),
    ];
    const recent = panels.recentIds();
    const order = (id: string) => {
      const index = recent.indexOf(id);
      // The current file is the least likely to be wanted.
      return index < 0 ? recent.length : index || recent.length + 1;
    };
    return listed.sort((a, b) => order(a.id) - order(b.id));
  }

  function commands(): WorkspaceCommand[] {
    const editing =
      activeId === scratchpadId ||
      nodes.some((node) => node.id === activeId && node.kind === "text");
    const idle = writable && ready && !sources.saving;
    const view = (rightView: SidebarView) => () =>
      updateChrome({ rightOpen: true, rightView });
    const panel = (panelView: PanelView) => () =>
      updateChrome({ panelOpen: true, panelView });
    const editor = (
      command: EditorCommand,
      writes = false,
    ): Pick<WorkspaceCommand, "disabled" | "run"> => ({
      disabled: !editing || (writes && !writable),
      run: () => panels.runCommand(command),
    });
    return [
      {
        label: "Go to file",
        shortcut: "quickOpen",
        run: () => openPalette("files"),
      },
      { label: "Save", shortcut: "save", disabled: !idle, run: save },
      {
        label: "Save without compiling",
        shortcut: "saveWithoutCompiling",
        disabled: !idle,
        run: saveOnly,
      },
      {
        label: "Save & compile",
        shortcut: "compile",
        disabled: !idle || !main,
        run: () => compile(),
      },
      {
        label: "Clean build",
        shortcut: "cleanBuild",
        disabled: !idle || !main || compilation.compiling,
        run: () => compile(true),
      },
      {
        label: "New file",
        disabled: !idle,
        run: () => createRef.current?.start("text"),
      },
      {
        label: "New folder",
        disabled: !idle,
        run: () => createRef.current?.start("folder"),
      },
      {
        label: "Upload files",
        disabled: !idle,
        run: () => uploadRef.current?.open(),
      },
      { label: "Export project", run: () => exportRef.current?.open() },
      { label: "Undo", ...editor("undo", true) },
      { label: "Redo", ...editor("redo", true) },
      { label: "Find in file", ...editor("find") },
      {
        label: "Format document",
        shortcut: "format",
        ...editor("format", true),
      },
      { label: "Toggle line wrapping", ...editor("wrap") },
      { label: "Symbol palette", ...editor("symbols", true) },
      {
        label: "Search in project",
        shortcut: "projectSearch",
        run: openSearch,
      },
      {
        label: "Add reference",
        disabled: !writable,
        run: () => addReference(),
      },
      {
        label: "Set this file as main document",
        disabled: !canSetMain,
        run: () => void setMain(),
      },
      {
        label: "Ask AI about the selection",
        disabled: !activePath || !editing,
        run: askAboutSelection,
      },
      {
        label: "Open scratchpad",
        disabled: !ready,
        run: panels.openScratchpad,
      },
      {
        label: "Toggle Agents sidebar",
        run: () => updateChrome({ agentsOpen: !chrome.agentsOpen }),
      },
      {
        label: "Toggle right sidebar",
        shortcut: "sidebar",
        run: () => updateChrome({ rightOpen: !chrome.rightOpen }),
      },
      { label: "Toggle panel", shortcut: "panel", run: () => togglePanel() },
      { label: "Show Files", run: view("files") },
      { label: "Show Outline", run: view("outline") },
      { label: "Show Search", run: view("search") },
      { label: "Show Git", run: view("git") },
      { label: "Show Comments", run: view("comments") },
      { label: "Show Collaboration", run: view("collaboration") },
      { label: "Show Problems", run: panel("problems") },
      { label: "Show Logs", run: panel("logs") },
      { label: "Show Terminal", run: panel("terminal") },
      {
        label: "Next editor tab",
        shortcut: "nextTab",
        run: () => panels.cycleTab(1),
      },
      {
        label: "Previous editor tab",
        shortcut: "previousTab",
        run: () => panels.cycleTab(-1),
      },
      {
        label: "Settings",
        shortcut: "settings",
        run: () => setSettingsOpen(true),
      },
    ];
  }

  const compile = (clean = false) => void compilation.compile(clean);
  const saveOnly = () => void sources.saveSources();
  const save = () => (compileSettings.onSave ? compile() : saveOnly());
  useWorkspaceShortcuts(container, {
    paused: settingsOpen,
    compiling: compilation.compiling,
    actions: {
      save,
      saveWithoutCompiling: saveOnly,
      compile: () => compile(),
      cleanBuild: () => compile(true),
      nextTab: () => panels.cycleTab(1),
      previousTab: () => panels.cycleTab(-1),
      projectSearch: openSearch,
      quickOpen: () => openPalette("files"),
      commandPalette: () => openPalette("commands"),
      sidebar: () => updateChrome({ rightOpen: !chrome.rightOpen }),
      panel: () => togglePanel(),
    },
  });

  const actions = useStableActions({
    holdDocument,
    editDocument: (id, run, options) => {
      if (!writable)
        return Promise.reject(
          new Error("You do not have permission to edit this project."),
        );
      return collaboration.edit(id, run, options);
    },
    askAi,
    reveal: panels.reveal,
    revealRange: panels.revealRange,
    revealPdf,
    closeTabs: panels.closeTabs,
    keepOpen: panels.keepOpen,
    openMarkdownPreview: panels.openMarkdownPreview,
    addSymbolPackage,
    addReference,
    registerEditor: panels.registerEditor,
    registerCommands: panels.registerCommands,
    reportCursor: panels.reportCursor,
    reportSyntax,
    reportGitBranch: git.reportBranch,
    reportGitFailure: git.reportFailure,
  } satisfies Omit<WorkspaceActions, "projectId" | "drafts">);
  const workspaceActions = useMemo<WorkspaceActions>(
    () => ({ projectId, drafts, ...actions }),
    [projectId, drafts, actions],
  );
  const formatSettings = formatting ?? defaultFormatSettings;
  const workspace = useMemo<Workspace>(
    () => ({
      collaboration: collaboration.snapshot,
      scratchpad: scratchpad.file,
      canWrite: writable,
      paths,
      main: mainFile,
      completion,
      jump: panels.jump,
      comments,
      formatSettings,
    }),
    [
      collaboration.snapshot,
      scratchpad.file,
      writable,
      paths,
      mainFile,
      completion,
      panels.jump,
      comments,
      formatSettings,
    ],
  );
  const { build, stale, pdf, pdfSaveState } = compilation;
  const buildState = useMemo<WorkspaceBuild>(
    () => ({ build, stale, pdf, pdfSaveState, synctex, pdfJump }),
    [build, stale, pdf, pdfSaveState, synctex, pdfJump],
  );
  const diagnostics = useMemo<WorkspaceDiagnostics>(
    () => ({ problems, allProblems }),
    [problems, allProblems],
  );

  async function onReady({ api: dock }: DockviewReadyEvent) {
    panels.connect(dock);
    for (const [id, value] of Object.entries(project.sourceContents)) {
      drafts.set(id, { value, savedValue: value });
      const path = paths.get(id);
      if (path) update(path, value);
    }
    const current = await sources.restoreBrowserDrafts({
      isCurrent: () => panels.api.current === dock,
      onMigrated: (id, value) => {
        const path = paths.get(id);
        if (path) update(path, value);
      },
    });
    if (!current) return;
    panels.restore(dock, initialDock, persistLayout);
    setReady(true);
  }

  return (
    <WorkspaceProvider
      actions={workspaceActions}
      workspace={workspace}
      build={buildState}
      diagnostics={diagnostics}
    >
      <SidebarProvider
        ref={container}
        className={cn(
          "h-svh min-h-0 flex-col overflow-hidden [--workspace-footer-height:2rem] [--workspace-header-height:2.5rem] **:data-[slot=sidebar-container]:transition-none **:data-[slot=sidebar-gap]:transition-none [&_[data-slot=sidebar-footer]]:p-0 [&_[data-slot=sidebar-group]]:p-0 [&_[data-slot=sidebar-menu]]:gap-0",
        )}
      >
        {settingsUsed && <SettingsDialog />}
        {referencesUsed && (
          <AddReferenceDialog
            request={referenceRequest}
            onClose={() => setReferenceRequest(null)}
            bibFiles={bibFiles}
            knownKeys={result.analysis.citations}
            readBib={readBib}
            appendBib={appendBib}
            createBib={createBib}
          />
        )}
        {paletteUsed && (
          <WorkspacePalette
            request={palette}
            files={paletteFiles}
            commands={commands}
            onClose={() => setPalette(null)}
          />
        )}
        <WorkspaceMenu
          name={name}
          canWrite={writable && ready}
          saving={sources.saving}
          compiling={compilation.compiling}
          compileAvailable={!!main}
          editorAvailable={
            activeId === scratchpadId ||
            nodes.some((node) => node.id === activeId && node.kind === "text")
          }
          scratchpadDisabled={!ready}
          onScratchpad={panels.openScratchpad}
          compileOnSave={compileSettings.onSave}
          onSave={save}
          onSaveOnly={saveOnly}
          onCompile={() => compile()}
          onClean={() => compile(true)}
          onCreate={(kind) => createRef.current?.start(kind)}
          onUpload={() => uploadRef.current?.open()}
          onExport={() => exportRef.current?.open()}
          onRepair={
            invalidProjectPaths(nodes).length
              ? () => repairRef.current?.open()
              : undefined
          }
          onSettings={() => setSettingsOpen(true)}
          onEditor={panels.runCommand}
          onSearch={openSearch}
          onQuickOpen={() => openPalette("files")}
          onCommandPalette={() => openPalette("commands")}
          onAddReference={() => addReference()}
          chrome={chrome}
          onChrome={updateChrome}
          onPanel={(view) => updateChrome({ panelOpen: true, panelView: view })}
        />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <WorkspaceAgentsSidebar
            projectId={projectId}
            prompt={assistantPrompt}
            chrome={chrome}
            onChrome={updateChrome}
          />
          <main
            id="main-content"
            tabIndex={-1}
            aria-label="Editor"
            className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden focus:outline-none"
          >
            {!ready && (
              <p role="status" className="border-b px-3 py-2 text-sm">
                Loading server sources and checking browser drafts…
              </p>
            )}
            {(sources.sourceError || fileStatus.error) && (
              <p
                role="alert"
                className="text-destructive border-b px-3 py-2 text-sm wrap-anywhere"
              >
                {sources.sourceError || fileStatus.error}
              </p>
            )}
            {sources.recovering && (
              <DraftRecovery
                name={name}
                drafts={sources.recovery}
                canRecover={
                  canWrite &&
                  Object.keys(sources.recovery).every(
                    (id) => collaboration.get(id)?.getStatus().ready,
                  )
                }
                onRecover={() =>
                  sources.resolveRecovery((id, value) =>
                    collaboration.get(id)?.replace(value),
                  )
                }
                onDiscard={() => sources.resolveRecovery()}
              />
            )}
            {actionError && (
              <p
                role="alert"
                className="text-destructive border-b px-3 py-2 text-sm wrap-anywhere"
              >
                {actionError}
              </p>
            )}
            {compilation.compileError && (
              <p
                role="alert"
                className="text-destructive border-b px-3 py-2 text-sm wrap-anywhere"
              >
                {compilation.compileError}
              </p>
            )}
            <div className="min-h-0 flex-1">
              <ClientOnly>
                <DockviewReact
                  className="isolate size-full"
                  theme={dockTheme}
                  components={dockComponents}
                  tabComponents={dockTabComponents}
                  defaultTabComponent={FileTab}
                  onReady={onReady}
                />
              </ClientOnly>
            </div>
            {chrome.panelOpen && (
              <WorkspacePanel
                view={chrome.panelView}
                height={chrome.panelHeight}
                problemCount={allProblems.length}
                openedAt={openedAt}
                onView={(panelView) => updateChrome({ panelView })}
                onResize={(panelHeight) => updateChrome({ panelHeight })}
                onClose={() => updateChrome({ panelOpen: false })}
              />
            )}
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
              open={chrome.rightOpen}
              onOpen={panels.openFile}
              onOpenGenerated={panels.openGenerated}
              sources={sources.sourceFiles}
              view={chrome.rightView}
              onClose={() => updateChrome({ rightOpen: false })}
              createRef={createRef}
              uploadRef={uploadRef}
              exportRef={exportRef}
              repairRef={repairRef}
              searchRequest={searchRequest}
            />
          </div>
        </div>
        <WorkspaceStatusBar
          chrome={chrome}
          onChrome={updateChrome}
          onTogglePanel={togglePanel}
          problemCount={allProblems.length}
          compileStatus={compilation.status}
          compileDisabled={!main || !writable || !ready || sources.saving}
          onCompile={() => compile()}
          words={main ? result.words : undefined}
          onRevealWords={(path, line) => panels.reveal(path, line)}
          git={git.state}
          scratchpadDisabled={!ready}
          onScratchpad={panels.openScratchpad}
          location={
            activeId === scratchpadId
              ? scratchpadTitle
              : activeId?.startsWith("out:")
                ? `out/${activeId.slice(4)}`
                : activeId
                  ? (paths.get(activeId) ?? "")
                  : "LaTeX workspace"
          }
          cursor={panels.cursor}
        />
      </SidebarProvider>
    </WorkspaceProvider>
  );
}
