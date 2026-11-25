import type { RefObject } from "react";

import type { EditorCommand } from "#/lib/editor/editor-command";
import type {
  PanelView,
  SidebarView,
  WorkspaceChrome,
} from "#/lib/workspace/workspace-layout";

import type { useDockPanels } from "../-hooks/use-dock-panels";
import type { useMainDocument } from "../-hooks/use-main-document";
import type { usePalette } from "../-hooks/use-palette";
import type { CreateNodeHandle } from "./create-node-form";
import type { ProjectExportHandle } from "./project-export";
import type { UploadSourceHandle } from "./upload-source";
import type { WorkspaceCommand } from "./workspace-palette";

/** Every command of the workspace, as the command palette lists them. */
export function workspaceCommands({
  writable,
  ready,
  idle,
  editing,
  compiling,
  main,
  activePath,
  chrome,
  updateChrome,
  togglePanel,
  panels,
  palette,
  mainDocument,
  menus,
  save,
  saveOnly,
  compile,
  openSearch,
  openSettings,
  addReference,
  askAboutSelection,
}: {
  writable: boolean;
  ready: boolean;
  /** The project can be changed now. */
  idle: boolean;
  /** A text editor is on screen. */
  editing: boolean;
  compiling: boolean;
  main: string | undefined;
  activePath: string | undefined;
  chrome: WorkspaceChrome;
  updateChrome: (patch: Partial<WorkspaceChrome>) => void;
  togglePanel: () => void;
  panels: Pick<
    ReturnType<typeof useDockPanels>,
    "runCommand" | "openScratchpad" | "cycleTab"
  >;
  palette: Pick<ReturnType<typeof usePalette>, "open">;
  mainDocument: Pick<
    ReturnType<typeof useMainDocument>,
    "canSetMain" | "setMain"
  >;
  menus: {
    create: RefObject<CreateNodeHandle | null>;
    upload: RefObject<UploadSourceHandle | null>;
    export: RefObject<ProjectExportHandle | null>;
  };
  save: () => void;
  saveOnly: () => void;
  compile: (clean?: boolean) => void;
  openSearch: () => void;
  openSettings: () => void;
  addReference: () => void;
  askAboutSelection: () => void;
}): WorkspaceCommand[] {
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
      run: () => palette.open("files"),
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
      disabled: !idle || !main || compiling,
      run: () => compile(true),
    },
    {
      label: "New file",
      disabled: !idle,
      run: () => menus.create.current?.start("text"),
    },
    {
      label: "New folder",
      disabled: !idle,
      run: () => menus.create.current?.start("folder"),
    },
    {
      label: "Upload files",
      disabled: !idle,
      run: () => menus.upload.current?.open(),
    },
    { label: "Export project", run: () => menus.export.current?.open() },
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
      disabled: !mainDocument.canSetMain,
      run: () => void mainDocument.setMain(),
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
      run: () => openSettings(),
    },
  ];
}
