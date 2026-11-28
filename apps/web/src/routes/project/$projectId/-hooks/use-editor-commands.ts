import { redo, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type {
  EditorState,
  EditorView,
  ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";

import type { CollaborativeFile } from "#/lib/collaboration/browser";
import type { EditorCommand } from "#/lib/editor/editor-command";
import { keymapHistory } from "#/lib/editor/keymaps/extension";

const readonlyBlockedCommands = new Set<EditorCommand>([
  "undo",
  "redo",
  "format",
  "cut",
  "paste",
  "symbols",
]);

export type HistoryStatus = { undo: boolean; redo: boolean };

export function isEditorCommandDisabled(
  command: EditorCommand,
  { readOnly, status }: { readOnly: boolean; status?: HistoryStatus },
) {
  if (readOnly && readonlyBlockedCommands.has(command)) return true;
  if (command === "undo" && status && !status.undo) return true;
  if (command === "redo" && status && !status.redo) return true;
  return false;
}

const selectedText = (state: EditorState) =>
  state.selection.ranges.map(({ from, to }) => state.sliceDoc(from, to));

/**
 * Whether a clipboard command that started in `before` may still change the
 * view. The clipboard can wait on a permission prompt, so by now the editor may
 * be closed or read-only, or other text may be selected. CodeMirror moves the
 * selection through edits elsewhere, so those don't matter.
 */
export function clipboardTargetUnchanged(
  before: EditorState,
  view: Pick<EditorView, "state" | "dom">,
) {
  if (!view.dom.isConnected || view.state.readOnly) return false;
  const previous = selectedText(before);
  const current = selectedText(view.state);
  return (
    previous.length === current.length &&
    previous.every((text, index) => text === current[index])
  );
}

/**
 * Wires CodeMirror history, clipboard, search, formatting, and palette commands
 * and exposes them to both the editor menus and the workspace command bus.
 */
export function useEditorCommands({
  editor,
  undoManager,
  readOnly,
  isLatex,
  canFormat,
  formatting,
  format,
  onToggleWrap,
  onToggleSymbols,
  onError,
  onCommands,
}: {
  editor: RefObject<ReactCodeMirrorRef | null>;
  undoManager?: CollaborativeFile["undoManager"];
  readOnly: boolean;
  isLatex: boolean;
  canFormat: boolean;
  formatting: boolean;
  format: (view: EditorView) => void;
  onToggleWrap: () => void;
  onToggleSymbols: () => void;
  onError: (message: string) => void;
  onCommands?: (run: ((command: EditorCommand) => void) | null) => void;
}) {
  const history = useMemo(
    () =>
      keymapHistory.of({
        undo: (view) =>
          view.state.readOnly
            ? null
            : undoManager
              ? undoManager.undo()
              : undo(view),
        redo: (view) =>
          view.state.readOnly
            ? null
            : undoManager
              ? undoManager.redo()
              : redo(view),
      }),
    [undoManager],
  );

  const commandRef = useRef<(command: EditorCommand) => void>(() => {});
  commandRef.current = (command) => {
    const view = editor.current?.view;
    if (!view) return;
    if (isEditorCommandDisabled(command, { readOnly })) return;
    const before = view.state;
    const selection = before.selection.main;
    const copy = async () =>
      navigator.clipboard.writeText(
        before.sliceDoc(selection.from, selection.to),
      );
    // A closed editor has nowhere to show the message.
    const report = (message: string) => {
      if (view.dom.isConnected) onError(message);
    };
    switch (command) {
      case "undo":
        if (undoManager) undoManager.undo();
        else undo(view);
        break;
      case "redo":
        if (undoManager) undoManager.redo();
        else redo(view);
        break;
      case "find":
        // Which focuses the search field.
        openSearchPanel(view);
        return;
      case "format":
        if (canFormat && !formatting) format(view);
        break;
      case "wrap":
        onToggleWrap();
        break;
      case "symbols":
        if (isLatex) onToggleSymbols();
        break;
      case "selectAll":
        view.dispatch({
          selection: { anchor: 0, head: view.state.doc.length },
        });
        break;
      case "copy":
        void copy().catch(() =>
          onError("Clipboard access failed. Use the copy keyboard shortcut."),
        );
        break;
      case "cut":
        void copy()
          .then(() => {
            if (!clipboardTargetUnchanged(before, view))
              return report(
                "The selection changed before it was cut. It was copied instead.",
              );
            const { from, to } = view.state.selection.main;
            view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
          })
          .catch(() =>
            onError("Clipboard access failed. Use the cut keyboard shortcut."),
          );
        break;
      case "paste":
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (!clipboardTargetUnchanged(before, view))
              return report(
                "The selection changed before the text was pasted. Paste again.",
              );
            view.dispatch(view.state.replaceSelection(text), {
              userEvent: "input.paste",
              scrollIntoView: true,
            });
          })
          .catch(() =>
            onError(
              "Clipboard access failed. Use the paste keyboard shortcut.",
            ),
          );
        break;
    }
    view.focus();
  };

  const runCommand = useCallback(
    (command: EditorCommand) => commandRef.current(command),
    [],
  );

  useEffect(() => {
    onCommands?.(runCommand);
    return () => onCommands?.(null);
  }, [onCommands, runCommand]);

  return { history, runCommand };
}
