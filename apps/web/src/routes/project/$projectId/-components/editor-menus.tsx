import {
  IconDots,
  IconEye,
  IconFolderOpen,
  IconMathSymbols,
  IconMessagePlus,
  IconSearch,
} from "@tabler/icons-react";
import { createContext, type ReactNode, useContext } from "react";

import {
  PanelAction,
  PanelActions,
  PanelHeader,
} from "#/components/panel-header";
import { Button } from "#/components/ui/button";
import { ContextMenuItem } from "#/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import type { EditorCommand } from "#/lib/editor/editor-command";

import {
  type HistoryStatus,
  isEditorCommandDisabled,
} from "../-hooks/use-editor-commands";

// The toolbar and the context menu are composed by the editor, which renders
// only the actions its file has. They share what every command needs.
type EditorMenu = {
  readOnly: boolean;
  formatting: boolean;
  status: HistoryStatus;
  run: (command: EditorCommand) => void;
};
const EditorMenuContext = createContext<EditorMenu | null>(null);

export function EditorMenuProvider({
  children,
  ...menu
}: EditorMenu & { children: ReactNode }) {
  return <EditorMenuContext value={menu}>{children}</EditorMenuContext>;
}

function useEditorMenu() {
  const menu = useContext(EditorMenuContext);
  if (!menu) throw new Error("Missing editor menu provider");
  return menu;
}

function useCommand(command: EditorCommand) {
  const { readOnly, formatting, status, run } = useEditorMenu();
  return {
    disabled:
      isEditorCommandDisabled(command, { readOnly, status }) ||
      (command === "format" && formatting),
    onClick: () => run(command),
  };
}

type ActionProps = { onClick: () => void };

export function EditorToolbar({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <PanelHeader title={title}>
      <PanelActions label="Editor actions">{children}</PanelActions>
    </PanelHeader>
  );
}

/** Opens the preview of the file, which `label` names. */
export function PreviewAction({
  label,
  onClick,
}: ActionProps & { label: string }) {
  return (
    <PanelAction label={`${label} (⌘/Ctrl+Shift+V)`} onClick={onClick}>
      <IconEye />
    </PanelAction>
  );
}

export function OpenFileAction({ onClick }: ActionProps) {
  return (
    <PanelAction label="Open source file" onClick={onClick}>
      <IconFolderOpen />
    </PanelAction>
  );
}

export function AddCommentAction({ onClick }: ActionProps) {
  return (
    <PanelAction label="Add comment" onClick={onClick}>
      <IconMessagePlus />
    </PanelAction>
  );
}

export function FindAction({ onClick }: ActionProps) {
  return (
    <PanelAction label="Find and replace" onClick={onClick}>
      <IconSearch />
    </PanelAction>
  );
}

export function SymbolsAction({
  expanded,
  onClick,
}: ActionProps & { expanded: boolean }) {
  const { readOnly } = useEditorMenu();
  return (
    <PanelAction
      label="LaTeX symbols"
      disabled={readOnly}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <IconMathSymbols />
    </PanelAction>
  );
}

export function MoreActions({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-xs" />}
        aria-label="More editor actions"
        title="More editor actions"
      >
        <IconDots />
      </DropdownMenuTrigger>
      <DropdownMenuContent>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MoreCommand({
  command,
  children,
}: {
  command: EditorCommand;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem {...useCommand(command)}>{children}</DropdownMenuItem>
  );
}

export function AddReferenceItem({ onClick }: ActionProps) {
  const { readOnly } = useEditorMenu();
  return (
    <DropdownMenuItem disabled={readOnly} onClick={onClick}>
      Add reference…
    </DropdownMenuItem>
  );
}

export function WrapLinesItem({ checked }: { checked: boolean }) {
  const { run } = useEditorMenu();
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      onCheckedChange={() => run("wrap")}
    >
      Wrap lines
    </DropdownMenuCheckboxItem>
  );
}

export function ContextCommand({
  command,
  children,
}: {
  command: EditorCommand;
  children: ReactNode;
}) {
  return <ContextMenuItem {...useCommand(command)}>{children}</ContextMenuItem>;
}
