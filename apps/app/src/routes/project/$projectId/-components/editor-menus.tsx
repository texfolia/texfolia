import {
  IconDots,
  IconEye,
  IconFolderOpen,
  IconMathSymbols,
  IconMessagePlus,
  IconSearch,
} from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { ContextMenuContent, ContextMenuItem } from "@texfolia/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@texfolia/ui/dropdown-menu";

import {
  PanelAction,
  PanelActions,
  PanelHeader,
} from "#/components/panel-header";
import type { EditorCommand } from "#/lib/editor/editor-command";

import {
  type HistoryStatus,
  isEditorCommandDisabled,
} from "../-hooks/use-editor-commands";

const contextMenuCommands: readonly [EditorCommand, string][] = [
  ["cut", "Cut"],
  ["copy", "Copy"],
  ["paste", "Paste"],
  ["selectAll", "Select all"],
  ["undo", "Undo"],
  ["redo", "Redo"],
  ["find", "Find"],
  ["format", "Format document"],
  ["symbols", "Symbol palette"],
];

export function EditorToolbar({
  title,
  isMarkdown,
  isLatex,
  canFormat,
  canAddReference,
  allowOpenFile,
  commenting,
  readOnly,
  showSymbols,
  formatting,
  wrapLines,
  status,
  onOpenPreview,
  onOpenFile,
  onAddComment,
  onFind,
  onToggleSymbols,
  onRevealPdf,
  onAddReference,
  onCommand,
  onDownload,
}: {
  title: string;
  isMarkdown: boolean;
  isLatex: boolean;
  canFormat: boolean;
  canAddReference: boolean;
  allowOpenFile: boolean;
  commenting: boolean;
  readOnly: boolean;
  showSymbols: boolean;
  formatting: boolean;
  wrapLines: boolean;
  status: HistoryStatus;
  onOpenPreview?: () => void;
  onOpenFile: () => void;
  onAddComment: () => void;
  onFind: () => void;
  onToggleSymbols: () => void;
  onRevealPdf?: () => void;
  onAddReference?: () => void;
  onCommand: (command: EditorCommand) => void;
  onDownload: () => void;
}) {
  return (
    <PanelHeader title={title}>
      <PanelActions label="Editor actions">
        {isMarkdown && onOpenPreview && (
          <PanelAction
            label="Open Markdown preview (⌘/Ctrl+Shift+V)"
            onClick={onOpenPreview}
          >
            <IconEye />
          </PanelAction>
        )}
        {allowOpenFile && (
          <PanelAction label="Open source file" onClick={onOpenFile}>
            <IconFolderOpen />
          </PanelAction>
        )}
        {commenting && (
          <PanelAction label="Add comment" onClick={onAddComment}>
            <IconMessagePlus />
          </PanelAction>
        )}
        <PanelAction label="Find and replace" onClick={onFind}>
          <IconSearch />
        </PanelAction>
        {isLatex && (
          <PanelAction
            label="LaTeX symbols"
            disabled={readOnly}
            aria-expanded={showSymbols}
            onClick={onToggleSymbols}
          >
            <IconMathSymbols />
          </PanelAction>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-xs" />}
            aria-label="More editor actions"
            title="More editor actions"
          >
            <IconDots />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {onRevealPdf && (
              <DropdownMenuItem onClick={onRevealPdf}>
                Reveal in PDF
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={readOnly || !status.undo}
              onClick={() => onCommand("undo")}
            >
              Undo
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={readOnly || !status.redo}
              onClick={() => onCommand("redo")}
            >
              Redo
            </DropdownMenuItem>
            {onAddReference && canAddReference && (
              <DropdownMenuItem disabled={readOnly} onClick={onAddReference}>
                Add reference…
              </DropdownMenuItem>
            )}
            {canFormat && (
              <DropdownMenuItem
                disabled={readOnly || formatting}
                onClick={() => onCommand("format")}
              >
                Format document
              </DropdownMenuItem>
            )}
            <DropdownMenuCheckboxItem
              checked={wrapLines}
              onCheckedChange={() => onCommand("wrap")}
            >
              Wrap lines
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDownload}>
              Download source
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PanelActions>
    </PanelHeader>
  );
}

export function EditorContextMenu({
  commenting,
  canFormat,
  isLatex,
  readOnly,
  status,
  onAddComment,
  onCommand,
}: {
  commenting: boolean;
  canFormat: boolean;
  isLatex: boolean;
  readOnly: boolean;
  status: HistoryStatus;
  onAddComment: () => void;
  onCommand: (command: EditorCommand) => void;
}) {
  return (
    <ContextMenuContent>
      {commenting && (
        <ContextMenuItem onClick={onAddComment}>Add comment</ContextMenuItem>
      )}
      {contextMenuCommands
        .filter(
          ([command]) =>
            (command !== "format" || canFormat) &&
            (command !== "symbols" || isLatex),
        )
        .map(([command, title]) => (
          <ContextMenuItem
            key={command}
            disabled={isEditorCommandDisabled(command, { readOnly, status })}
            onClick={() => onCommand(command)}
          >
            {title}
          </ContextMenuItem>
        ))}
    </ContextMenuContent>
  );
}
