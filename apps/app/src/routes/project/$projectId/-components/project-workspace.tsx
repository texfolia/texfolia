import { useLiveQuery } from "@tanstack/react-db";
import { ClientOnly } from "@tanstack/react-router";

import "dockview-react/dist/styles/dockview.css";
import { SidebarProvider } from "@texfolia/ui/sidebar";
import { cn } from "cn";
import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { SettingsDialog } from "#/components/settings-dialog";
import { entryAppendix } from "#/features/editor/latex/bibtex";
import { latexCompletion } from "#/features/editor/latex/completion";
import { projectOutline } from "#/features/editor/latex/outline";
import {
  addLatexPackage,
  packageInsertion,
} from "#/features/editor/latex/symbols";
import { sourceToPdf } from "#/features/editor/latex/synctex";
import { projectPaths, invalidProjectPaths } from "#/features/projects";
import type { ProjectDetails } from "#/features/projects/project.functions";
import { encodeSource } from "#/features/storage";
import { workspaceLayoutKey } from "#/features/workspace/workspace-layout";
import { useComments } from "#/hooks/use-comments";
import { useLatexAnalysis } from "#/hooks/use-latex-analysis";
import { useSyncTex } from "#/hooks/use-synctex";
import { useProjectFiles } from "#/providers/project-files-provider";
import { useSettings } from "#/providers/settings-provider";
import {
  type FileState,
  type Workspace,
  WorkspaceProvider,
} from "#/providers/workspace-provider";

import { useCollaborationFiles } from "../-hooks/use-collaboration-files";
import { useCompilation } from "../-hooks/use-compilation";
import { useDockPanels } from "../-hooks/use-dock-panels";
import { useSavedSources } from "../-hooks/use-saved-sources";
import { sourceDraftsKey, useSourceSave } from "../-hooks/use-source-save";
import { useWorkspaceChrome } from "../-hooks/use-workspace-chrome";
import { useWorkspaceProblems } from "../-hooks/use-workspace-problems";
import {
  useExitWhenStorageCleared,
  useGitBranch,
} from "../-hooks/use-workspace-session";
import { useWorkspaceShortcuts } from "../-hooks/use-workspace-shortcuts";
import {
  AddReferenceDialog,
  type AddReferenceRequest,
  newBibFile,
} from "./add-reference-dialog";
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
import { WorkspacePanel } from "./workspace-panel";
import { WorkspaceStatusBar } from "./workspace-status-bar";

const defaultFormatSettings = { indent: 2, wrap: true, width: 80 };

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
  const [drafts] = useState(() => new Map<string, FileState>());
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

  const paths = useMemo(() => projectPaths(nodes), [nodes]);
  const filenames = useMemo(() => [...paths.values()], [paths]);
  const { main, mainId } = useMemo(() => {
    let main: string | undefined;
    let mainId: string | undefined;
    for (const [id, path] of paths) {
      if (path === "main.tex") return { main: path, mainId: id };
      if (!main && path.endsWith(".tex")) [main, mainId] = [path, id];
    }
    return { main, mainId };
  }, [paths]);
  const { result, update, revision } = useLatexAnalysis(filenames, main);
  const readAnalysis = useEffectEvent(() => result.analysis);
  const completion = useMemo(
    () => latexCompletion(readAnalysis, filenames),
    [filenames],
  );

  const panels = useDockPanels({
    files,
    nodes,
    paths,
    drafts,
    ready,
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
  // Drafts are recovered into live documents.
  const { hold } = collaboration;
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
  const [pdfJump, setPdfJump] = useState<Workspace["pdfJump"]>(null);
  const [searchRequest, setSearchRequest] = useState<SearchRequest>({
    sequence: 0,
  });
  const [referenceRequest, setReferenceRequest] =
    useState<AddReferenceRequest | null>(null);
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
      sidebar: () => updateChrome({ rightOpen: !chrome.rightOpen }),
      panel: () => togglePanel(),
    },
  });

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

  const mainDraft = mainId ? drafts.get(mainId) : undefined;
  const { activeId } = panels;
  return (
    <WorkspaceProvider
      value={{
        collaboration: collaboration.snapshot,
        holdDocument: hold,
        editDocument: (id, run) => {
          if (!writable)
            return Promise.reject(
              new Error("You do not have permission to edit this project."),
            );
          return collaboration.edit(id, run);
        },
        projectId,
        canWrite: writable,
        build: compilation.build,
        stale: compilation.stale,
        drafts,
        keepOpen: panels.keepOpen,
        openMarkdownPreview: panels.openMarkdownPreview,
        registerEditor: panels.registerEditor,
        symbolPreamble:
          main && mainDraft
            ? { source: mainDraft.value, filename: main }
            : undefined,
        addSymbolPackage,
        addReference,
        paths,
        completion,
        problems,
        allProblems,
        reveal: panels.reveal,
        revealRange: panels.revealRange,
        comments,
        closeTabs: panels.closeTabs,
        reportGitBranch: git.reportBranch,
        reportGitFailure: git.reportFailure,
        registerCommands: panels.registerCommands,
        reportCursor: panels.reportCursor,
        reportSyntax,
        jump: panels.jump,
        pdf: compilation.pdf,
        synctex,
        pdfJump,
        revealPdf,
        pdfSaveState: compilation.pdfSaveState,
        formatSettings: formatting ?? defaultFormatSettings,
      }}
    >
      <SidebarProvider
        ref={container}
        className={cn(
          "h-svh min-h-0 flex-col overflow-hidden [--workspace-footer-height:2rem] [--workspace-header-height:2.5rem] **:data-[slot=sidebar-container]:transition-none **:data-[slot=sidebar-gap]:transition-none [&_[data-slot=sidebar-footer]]:p-0 [&_[data-slot=sidebar-group]]:p-0 [&_[data-slot=sidebar-menu]]:gap-0",
        )}
      >
        <SettingsDialog />
        <AddReferenceDialog
          request={referenceRequest}
          onClose={() => setReferenceRequest(null)}
          bibFiles={bibFiles}
          knownKeys={result.analysis.citations}
          readBib={readBib}
          appendBib={appendBib}
          createBib={createBib}
        />
        <WorkspaceMenu
          name={name}
          canWrite={writable && ready}
          saving={sources.saving}
          compiling={compilation.compiling}
          compileAvailable={!!main}
          editorAvailable={nodes.some(
            (node) => node.id === activeId && node.kind === "text",
          )}
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
          onAddReference={() => addReference()}
          chrome={chrome}
          onChrome={updateChrome}
          onPanel={(view) => updateChrome({ panelOpen: true, panelView: view })}
        />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <WorkspaceAgentsSidebar
            projectId={projectId}
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
                  theme={{
                    name: "texfolia",
                    className: "dockview-theme-texfolia",
                  }}
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
              outline={projectOutline(
                new Map(
                  [...paths].flatMap(([id, path]) => {
                    const draft = drafts.get(id);
                    return draft ? [[path, draft.value]] : [];
                  }),
                ),
                main,
              )}
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
          location={
            activeId?.startsWith("out:")
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
