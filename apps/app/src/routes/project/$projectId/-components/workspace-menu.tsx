import { Link } from "@tanstack/react-router";
import {
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarSeparator,
  MenubarGroup,
  MenubarCheckboxItem,
} from "@texfolia/ui/menubar";

import type { EditorCommand } from "#/lib/editor/editor-command";
import type {
  PanelView,
  SidebarView,
  WorkspaceChrome,
} from "#/lib/workspace/workspace-layout";

export function WorkspaceMenu({
  name,
  canWrite,
  saving,
  compiling,
  compileAvailable,
  editorAvailable,
  scratchpadDisabled,
  compileOnSave,
  onSave,
  onSaveOnly,
  onCompile,
  onClean,
  onCreate,
  onUpload,
  onExport,
  onRepair,
  onSettings,
  onEditor,
  onSearch,
  onAddReference,
  onScratchpad,
  chrome,
  onChrome,
  onPanel,
}: {
  name: string;
  canWrite: boolean;
  saving: boolean;
  compiling: boolean;
  compileAvailable: boolean;
  editorAvailable: boolean;
  scratchpadDisabled: boolean;
  compileOnSave: boolean;
  onSave: () => void;
  onSaveOnly: () => void;
  onCompile: () => void;
  onClean: () => void;
  onCreate: (kind: "text" | "folder") => void;
  onUpload: () => void;
  onExport: () => void;
  onRepair?: () => void;
  onSettings: () => void;
  onEditor: (command: EditorCommand) => void;
  onSearch: () => void;
  onAddReference: () => void;
  onScratchpad: () => void;
  chrome: WorkspaceChrome;
  onChrome: (patch: Partial<WorkspaceChrome>) => void;
  onPanel: (view: PanelView) => void;
}) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b bg-(--activity-background) px-2 text-(--activity-foreground)">
      <a
        href="#main-content"
        className="bg-background text-foreground sr-only z-50 p-3 focus:not-sr-only focus:absolute"
      >
        Skip to editor
      </a>
      <Menubar
        aria-label="Workspace menu"
        className="h-8 shrink-0 border-0 bg-transparent p-0"
      >
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent>
            <MenubarGroup>
              <MenubarItem render={<Link to="/projects" />}>
                Back to Projects
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem
                disabled={!canWrite}
                onClick={() => onCreate("text")}
              >
                New file
              </MenubarItem>
              <MenubarItem
                disabled={!canWrite}
                onClick={() => onCreate("folder")}
              >
                New folder
              </MenubarItem>
              <MenubarItem disabled={!canWrite} onClick={onUpload}>
                Upload
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem disabled={!canWrite || saving} onClick={onSave}>
                {compileAvailable && compileOnSave ? "Save & compile" : "Save"}
              </MenubarItem>
              {compileAvailable && (
                <MenubarItem
                  disabled={!canWrite || saving}
                  onClick={compileOnSave ? onSaveOnly : onCompile}
                >
                  {compileOnSave ? "Save without compiling" : "Save & compile"}
                </MenubarItem>
              )}
              <MenubarItem
                disabled={!canWrite || !compileAvailable || saving || compiling}
                onClick={onClean}
              >
                Clean build
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onClick={onExport}>Export project</MenubarItem>
              {onRepair && (
                <MenubarItem onClick={onRepair}>
                  Repair source paths
                </MenubarItem>
              )}
              <MenubarItem onClick={onSettings}>Settings</MenubarItem>
            </MenubarGroup>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Edit</MenubarTrigger>
          <MenubarContent>
            <MenubarGroup>
              {(
                [
                  ["undo", "Undo"],
                  ["redo", "Redo"],
                  ["find", "Find"],
                  ["format", "Format document"],
                  ["wrap", "Wrap lines"],
                ] satisfies [EditorCommand, string][]
              ).map(([command, title]) => (
                <MenubarItem
                  key={command}
                  disabled={
                    !editorAvailable ||
                    (!canWrite && ["undo", "redo", "format"].includes(command))
                  }
                  onClick={() => onEditor(command)}
                >
                  {title}
                </MenubarItem>
              ))}
              <MenubarSeparator />
              <MenubarItem onClick={onSearch}>Search in project</MenubarItem>
              <MenubarItem disabled={!canWrite} onClick={onAddReference}>
                Add reference…
              </MenubarItem>
            </MenubarGroup>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>View</MenubarTrigger>
          <MenubarContent>
            <MenubarGroup>
              <MenubarCheckboxItem
                checked={chrome.agentsOpen}
                onCheckedChange={(agentsOpen) => onChrome({ agentsOpen })}
              >
                Agents sidebar
              </MenubarCheckboxItem>
              <MenubarCheckboxItem
                checked={chrome.rightOpen}
                onCheckedChange={(rightOpen) => onChrome({ rightOpen })}
              >
                Right sidebar
              </MenubarCheckboxItem>
              <MenubarSeparator />
              <MenubarItem disabled={scratchpadDisabled} onClick={onScratchpad}>
                Scratchpad
              </MenubarItem>
              <MenubarSeparator />
              <MenubarCheckboxItem
                checked={chrome.panelOpen}
                onCheckedChange={(panelOpen) => onChrome({ panelOpen })}
              >
                Panel
              </MenubarCheckboxItem>
              <MenubarItem onClick={() => onPanel("problems")}>
                Problems
              </MenubarItem>
              <MenubarItem onClick={() => onPanel("logs")}>Logs</MenubarItem>
              <MenubarItem onClick={() => onPanel("terminal")}>
                Terminal
              </MenubarItem>
              <MenubarSeparator />
              {(
                [
                  ["files", "Files"],
                  ["outline", "Outline"],
                  ["search", "Search"],
                  ["git", "Git"],
                  ["comments", "Comments"],
                  ["collaboration", "Collaboration"],
                ] satisfies [SidebarView, string][]
              ).map(([rightView, title]) => (
                <MenubarCheckboxItem
                  key={rightView}
                  checked={chrome.rightOpen && chrome.rightView === rightView}
                  onCheckedChange={() =>
                    onChrome({ rightOpen: true, rightView })
                  }
                >
                  {title}
                </MenubarCheckboxItem>
              ))}
            </MenubarGroup>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <h1
        className="min-w-0 flex-1 truncate text-center text-xs font-medium"
        title={name}
      >
        {name}
      </h1>
      <div className="w-24 shrink-0 max-sm:hidden" />
    </header>
  );
}
