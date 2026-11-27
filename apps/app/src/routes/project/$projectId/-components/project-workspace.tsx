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
import { useStableActions } from "#/hooks/use-stable-callback";
import { useSyncTex } from "#/hooks/use-synctex";
import { scratchpadId } from "#/lib/collaboration";
import { CollaborationConnection } from "#/lib/collaboration/browser";
import type { ProjectDetails } from "#/lib/projects/project.functions";
import { FileDrafts } from "#/lib/workspace/file-drafts";
import { workspaceLayoutKey } from "#/lib/workspace/workspace-layout";
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
import { useMainDocument } from "../-hooks/use-main-document";
import { usePalette } from "../-hooks/use-palette";
import { useProjectDocuments } from "../-hooks/use-project-documents";
import { useReferences } from "../-hooks/use-references";
import { useSavedSources } from "../-hooks/use-saved-sources";
import { useScratchpad } from "../-hooks/use-scratchpad";
import { useSourceSave } from "../-hooks/use-source-save";
import { useWorkspaceChrome } from "../-hooks/use-workspace-chrome";
import { useWorkspaceProblems } from "../-hooks/use-workspace-problems";
import { useWorkspaceRequests } from "../-hooks/use-workspace-requests";
import {
  useExitWhenStorageCleared,
  useGitBranch,
} from "../-hooks/use-workspace-session";
import { useWorkspaceShortcuts } from "../-hooks/use-workspace-shortcuts";
import type { CreateNodeHandle } from "./create-node-form";
import { dockComponents, dockTabComponents, FileTab } from "./dock-panels";
import type { ProjectExportHandle } from "./project-export";
import { ProjectSidebar } from "./project-sidebar";
import { SidebarResize } from "./sidebar-resize";
import type { UploadSourceHandle } from "./upload-source";
import { WorkspaceAgentsSidebar } from "./workspace-agents-sidebar";
import { workspaceCommands } from "./workspace-commands";
import { WorkspaceDialogs } from "./workspace-dialogs";
import { WorkspaceMenu } from "./workspace-menu";
import { WorkspaceStatusBar } from "./workspace-status-bar";

const WorkspacePanel = lazyPanel("This panel", async () => {
  const { WorkspacePanel } = await import("./workspace-panel");
  return WorkspacePanel;
});

const defaultFormatSettings = { indent: 2, wrap: true, width: 80 };
const dockTheme = { name: "texfolia", className: "dockview-theme-texfolia" };

function tabLocation(
  id: string | undefined,
  paths: ReadonlyMap<string, string>,
) {
  if (!id) return "LaTeX workspace";
  if (id === scratchpadId) return scratchpadTitle;
  if (id.startsWith("out:")) return `out/${id.slice(4)}`;
  return paths.get(id) ?? "";
}

function WorkspaceAlert({ children }: { children: string | null | undefined }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="text-destructive border-b px-3 py-2 text-sm wrap-anywhere"
    >
      {children}
    </p>
  );
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
  // Each file's live and saved text, shared with the editors by reference.
  const [drafts] = useState(() => new FileDrafts());
  const [ready, setReady] = useState(false);
  const layoutKey = workspaceLayoutKey(userId, projectId);
  useExitWhenStorageCleared([layoutKey]);
  const git = useGitBranch(projectId, ready);
  const {
    formatting,
    compile: compileSettings,
    open: settingsOpen,
    setOpen: setSettingsOpen,
  } = useSettings();

  const { paths, filenames, mainFile, result, update, revision, completion } =
    useProjectDocuments(nodes, fileStatus.mainFile);
  const main = mainFile?.path;
  const mainId = mainFile?.id;

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
  // One multiplexed collaboration WebSocket shared by open files and scratchpad.
  const [collaborationConnection] = useState(
    () => new CollaborationConnection(projectId),
  );
  useEffect(
    () => () => collaborationConnection.destroy(),
    [collaborationConnection],
  );
  const collaboration = useCollaborationFiles({
    projectId,
    userId,
    canWrite,
    ready,
    nodes,
    deleted: fileStatus.deleted,
    connection: collaborationConnection,
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
    projectId,
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
    connection: collaborationConnection,
    onChange: panels.showScratchpad,
  });
  const { hold } = collaboration;
  const { hold: holdScratchpad } = scratchpad;
  const holdDocument = useCallback(
    (id: string) => (id === scratchpadId ? holdScratchpad(id) : hold(id)),
    [hold, holdScratchpad],
  );
  const writable = canWrite;
  const compilation = useCompilation({
    projectId,
    canWrite,
    main,
    filenames,
    nodes,
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
  const references = useReferences({
    writable,
    files,
    nodes,
    paths,
    drafts,
    panels,
    collaboration,
  });
  const { addReference } = references;
  const palette = usePalette({ nodes, paths, panels, compilation });
  const { activeId } = panels;
  const activePath = activeId ? paths.get(activeId) : undefined;
  const requests = useWorkspaceRequests({
    activePath,
    panels,
    build: compilation.build,
    synctex,
    updateChrome,
  });
  const { pdfJump, openSearch, askAi } = requests;
  const mainDocument = useMainDocument({
    writable,
    files,
    main,
    mainId,
    activePath,
    panels,
    collaboration,
  });

  function observeChange(id: string, value: string, local?: boolean) {
    const previous = drafts.get(id) ?? { value: "", savedValue: "" };
    const savedValue =
      !local &&
      collaboration.get(id)?.isSaved(files.sourceVersions[id]?.objectKey)
        ? value
        : previous.savedValue;
    drafts.set(id, { value, savedValue });
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

  const editing =
    activeId === scratchpadId ||
    nodes.some((node) => node.id === activeId && node.kind === "text");
  const compile = (clean = false) => void compilation.compile(clean);
  const saveOnly = () => void sources.saveSources();
  const save = () => (compileSettings.onSave ? compile() : saveOnly());
  const openSettings = () => setSettingsOpen(true);
  const commands = () =>
    workspaceCommands({
      writable,
      ready,
      idle: writable && ready && !sources.saving,
      editing,
      compiling: compilation.compiling,
      main,
      activePath,
      chrome,
      updateChrome,
      togglePanel: () => togglePanel(),
      panels,
      palette,
      mainDocument,
      menus: { create: createRef, upload: uploadRef, export: exportRef },
      save,
      saveOnly,
      compile,
      openSearch,
      openSettings,
      addReference,
      askAboutSelection: requests.askAboutSelection,
    });
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
      quickOpen: () => palette.open("files"),
      commandPalette: () => palette.open("commands"),
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
    revealPdf: requests.revealPdf,
    closeTabs: panels.closeTabs,
    keepOpen: panels.keepOpen,
    openMarkdownPreview: panels.openMarkdownPreview,
    addSymbolPackage: mainDocument.addSymbolPackage,
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

  function onReady({ api: dock }: DockviewReadyEvent) {
    panels.connect(dock);
    for (const [id, value] of Object.entries(project.sourceContents)) {
      drafts.set(id, { value, savedValue: value });
      const path = paths.get(id);
      if (path) update(path, value);
    }
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
        <WorkspaceDialogs
          settingsOpen={settingsOpen}
          references={references}
          knownKeys={result.analysis.citations}
          palette={palette}
          commands={commands}
        />
        <WorkspaceMenu
          name={name}
          canWrite={writable && ready}
          saving={sources.saving}
          compiling={compilation.compiling}
          compileAvailable={!!main}
          editorAvailable={editing}
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
          onSettings={openSettings}
          onEditor={panels.runCommand}
          onSearch={openSearch}
          onQuickOpen={() => palette.open("files")}
          onCommandPalette={() => palette.open("commands")}
          onAddReference={() => addReference()}
          chrome={chrome}
          onChrome={updateChrome}
          onPanel={(view) => updateChrome({ panelOpen: true, panelView: view })}
        />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <WorkspaceAgentsSidebar
            projectId={projectId}
            prompt={requests.assistantPrompt}
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
                Loading server sources…
              </p>
            )}
            <WorkspaceAlert>
              {sources.sourceError || fileStatus.error}
            </WorkspaceAlert>
            <WorkspaceAlert>{mainDocument.error}</WorkspaceAlert>
            <WorkspaceAlert>{compilation.compileError}</WorkspaceAlert>
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
              searchRequest={requests.searchRequest}
            />
          </div>
        </div>
        <WorkspaceStatusBar
          chrome={chrome}
          onChrome={updateChrome}
          onTogglePanel={togglePanel}
          problemCount={allProblems.length}
          unresolvedCommentCount={
            comments.data?.threads.filter((thread) => !thread.resolvedAt)
              .length ?? 0
          }
          compileStatus={compilation.status}
          compileDisabled={!main || !writable || !ready || sources.saving}
          onCompile={() => compile()}
          words={main ? result.words : undefined}
          onRevealWords={(path, line) => panels.reveal(path, line)}
          git={git.state}
          scratchpadDisabled={!ready}
          onScratchpad={panels.openScratchpad}
          paths={paths}
          onOpenFile={(nodeId) => {
            const node = nodes.find((item) => item.id === nodeId);
            if (node) panels.openFile(node, false);
          }}
          location={tabLocation(activeId, paths)}
          cursor={panels.cursor}
        />
      </SidebarProvider>
    </WorkspaceProvider>
  );
}
