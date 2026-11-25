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

import { ShortcutMenuItem, useMenuShortcut } from "#/components/menu-shortcut";
import type { EditorCommand } from "#/lib/editor/editor-command";
import type { ShortcutAction } from "#/lib/shortcuts/shortcuts";
import type {
  PanelView,
  SidebarView,
  WorkspaceChrome,
} from "#/lib/workspace/workspace-layout";
import { useSettings } from "#/providers/settings-provider";

/** Keys of the editor itself, which settings do not change. */
const editorKeys = { undo: "Mod+Z", redo: "Mod+Shift+Z", find: "Mod+F" };

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
  onQuickOpen,
  onCommandPalette,
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
  onQuickOpen: () => void;
  onCommandPalette: () => void;
  onAddReference: () => void;
  onScratchpad: () => void;
  chrome: WorkspaceChrome;
  onChrome: (patch: Partial<WorkspaceChrome>) => void;
  onPanel: (view: PanelView) => void;
}) {
  const { editor } = useSettings();
  // Vim and Emacs have their own keys for these.
  const standardKeys = editor.keymap === "default" ? editorKeys : undefined;
  const sidebarKeys = useMenuShortcut({ action: "sidebar" });
  const panelKeys = useMenuShortcut({ action: "panel" });
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
          <MenubarContent className="w-auto min-w-40 whitespace-nowrap">
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
              <ShortcutMenuItem
                action="save"
                disabled={!canWrite || saving}
                onClick={onSave}
              >
                {compileAvailable && compileOnSave ? "Save & compile" : "Save"}
              </ShortcutMenuItem>
              {compileAvailable && (
                <ShortcutMenuItem
                  action={compileOnSave ? "saveWithoutCompiling" : "compile"}
                  disabled={!canWrite || saving}
                  onClick={compileOnSave ? onSaveOnly : onCompile}
                >
                  {compileOnSave ? "Save without compiling" : "Save & compile"}
                </ShortcutMenuItem>
              )}
              <ShortcutMenuItem
                action="cleanBuild"
                disabled={!canWrite || !compileAvailable || saving || compiling}
                onClick={onClean}
              >
                Clean build
              </ShortcutMenuItem>
              <MenubarSeparator />
              <MenubarItem onClick={onExport}>Export project</MenubarItem>
              {onRepair && (
                <MenubarItem onClick={onRepair}>
                  Repair source paths
                </MenubarItem>
              )}
              <ShortcutMenuItem action="settings" onClick={onSettings}>
                Settings
              </ShortcutMenuItem>
            </MenubarGroup>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>Edit</MenubarTrigger>
          <MenubarContent className="w-auto min-w-40 whitespace-nowrap">
            <MenubarGroup>
              {(
                [
                  ["undo", "Undo", { binding: standardKeys?.undo }],
                  ["redo", "Redo", { binding: standardKeys?.redo }],
                  ["find", "Find", { binding: standardKeys?.find }],
                  ["format", "Format document", { action: "format" }],
                  ["wrap", "Wrap lines", {}],
                ] satisfies [
                  EditorCommand,
                  string,
                  { action?: ShortcutAction; binding?: string },
                ][]
              ).map(([command, title, keys]) => (
                <ShortcutMenuItem
                  {...keys}
                  key={command}
                  disabled={
                    !editorAvailable ||
                    (!canWrite && ["undo", "redo", "format"].includes(command))
                  }
                  onClick={() => onEditor(command)}
                >
                  {title}
                </ShortcutMenuItem>
              ))}
              <MenubarSeparator />
              <ShortcutMenuItem action="projectSearch" onClick={onSearch}>
                Search in project
              </ShortcutMenuItem>
              <MenubarItem disabled={!canWrite} onClick={onAddReference}>
                Add reference…
              </MenubarItem>
            </MenubarGroup>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>View</MenubarTrigger>
          <MenubarContent className="w-auto min-w-40 whitespace-nowrap">
            <MenubarGroup>
              <ShortcutMenuItem
                action="commandPalette"
                onClick={onCommandPalette}
              >
                Command palette…
              </ShortcutMenuItem>
              <ShortcutMenuItem action="quickOpen" onClick={onQuickOpen}>
                Go to file…
              </ShortcutMenuItem>
              <MenubarSeparator />
              <MenubarCheckboxItem
                checked={chrome.agentsOpen}
                onCheckedChange={(agentsOpen) => onChrome({ agentsOpen })}
              >
                Agents sidebar
              </MenubarCheckboxItem>
              <MenubarCheckboxItem
                checked={chrome.rightOpen}
                onCheckedChange={(rightOpen) => onChrome({ rightOpen })}
                aria-keyshortcuts={sidebarKeys.keys}
              >
                Right sidebar
                {sidebarKeys.hint}
              </MenubarCheckboxItem>
              <MenubarSeparator />
              <MenubarItem disabled={scratchpadDisabled} onClick={onScratchpad}>
                Scratchpad
              </MenubarItem>
              <MenubarSeparator />
              <MenubarCheckboxItem
                checked={chrome.panelOpen}
                onCheckedChange={(panelOpen) => onChrome({ panelOpen })}
                aria-keyshortcuts={panelKeys.keys}
              >
                Panel
                {panelKeys.hint}
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
