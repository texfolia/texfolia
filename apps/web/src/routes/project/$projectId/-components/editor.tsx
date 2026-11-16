import {
  acceptCompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import {
  indentLess,
  indentMore,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { indentUnit } from "@codemirror/language";
import { openSearchPanel } from "@codemirror/search";
import {
  IconEye,
  IconFolderOpen,
  IconSearch,
  IconDots,
  IconMathSymbols,
} from "@tabler/icons-react";
import CodeMirror, {
  EditorState,
  EditorView,
  keymap,
  Prec,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  yCollab,
  ySyncAnnotation,
  yUndoManagerKeymap,
} from "y-codemirror.next";
import * as Y from "yjs";

import {
  PanelAction,
  PanelActions,
  PanelHeader,
} from "#/components/panel-header";
import { Button } from "#/components/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "#/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "#/components/ui/dropdown-menu";
import { useLatexFormatter } from "#/hooks/use-latex-formatter";
import type { CollaborativeFile } from "#/lib/collaboration/file";
import { downloadFile } from "#/lib/download-file";
import type { EditorCommand } from "#/lib/editor-command";
import type { LatexProblem } from "#/lib/latex/analysis";
import {
  applyLatexHeading,
  headingCommands,
  toggleLatexCommand,
} from "#/lib/latex/editor-commands";
import { defaultFormatSettings, type FormatSettings } from "#/lib/latex/format";
import { editorLanguage, projectProblemsChanged } from "#/lib/latex/language";
import { addLatexPackage, insertLatexSymbol } from "#/lib/latex/symbols";
import { useSettings } from "#/providers/settings-provider";
import { useAppShortcut } from "#/providers/shortcuts-provider";
import { useTheme } from "#/providers/theme-provider";

import { SymbolPalette, type SymbolPreamble } from "./symbol-palette";

type EditorProps = {
  onCursorPosition?: (position: { line: number; column: number }) => void;
  onCommands?: (run: ((command: EditorCommand) => void) | null) => void;
  collaboration?: CollaborativeFile;
  readOnly?: boolean;
  defaultValue?: string;
  savedValue?: string;
  filename?: string;
  onChange?: (value: string) => void;
  onCreateEditor?: (view: EditorView) => void;
  onOpenPreview?: () => void;
  allowOpenFile?: boolean;
  completion?: CompletionSource;
  problems?: LatexProblem[];
  onSyntaxProblems?: (problems: LatexProblem[]) => void;
  jump?: { line: number };
  formatSettings?: FormatSettings;
  preamble?: SymbolPreamble;
};

export function Editor({
  onCursorPosition,
  onCommands,
  collaboration,
  readOnly = false,
  defaultValue = "",
  savedValue,
  filename = "main.tex",
  onChange,
  onCreateEditor,
  onOpenPreview,
  allowOpenFile = true,
  completion,
  problems,
  onSyntaxProblems,
  jump,
  formatSettings = defaultFormatSettings,
  preamble,
}: EditorProps) {
  const { theme } = useTheme();
  const editor = useRef<ReactCodeMirrorRef>(null);
  const problemsRef = useRef(problems);
  problemsRef.current = problems;
  const syntaxCallback = useRef(onSyntaxProblems);
  syntaxCallback.current = onSyntaxProblems;
  const container = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const openRequest = useRef(0);
  const [value, setValue] = useState(defaultValue);
  const [name, setName] = useState(filename);
  const [downloadedValue, setDownloadedValue] = useState(defaultValue);
  const { editor: preferences, updateEditor } = useSettings();
  const [error, setError] = useState("");
  const [showSymbols, setShowSymbols] = useState(false);
  const [status, setStatus] = useState({
    undo: false,
    redo: false,
  });
  const undoManager = useMemo(
    () => (collaboration ? new Y.UndoManager(collaboration.text) : undefined),
    [collaboration],
  );
  useEffect(() => () => undoManager?.destroy(), [undoManager]);
  const runUndo = (view: EditorView) =>
    undoManager ? undoManager.undo() : undo(view);
  const runRedo = (view: EditorView) =>
    undoManager ? undoManager.redo() : redo(view);
  const modified = value !== (savedValue ?? downloadedValue);
  const isLatex = /\.(?:tex|ltx|sty|cls)$/i.test(name);
  const isMarkdown = /\.(?:md|markdown)$/i.test(name);
  const canFormat = isLatex || /\.bib$/i.test(name);
  const { format, formatting, formatError } = useLatexFormatter(formatSettings);

  useAppShortcut("markdown", () => onOpenPreview?.(), {
    target: container,
    enabled: isMarkdown && !!onOpenPreview,
  });
  useAppShortcut(
    "bold",
    () => {
      const view = editor.current?.view;
      if (view) toggleLatexCommand("textbf")(view);
    },
    { target: container, enabled: isLatex && !readOnly },
  );
  useAppShortcut(
    "italic",
    () => {
      const view = editor.current?.view;
      if (view) toggleLatexCommand("textit")(view);
    },
    { target: container, enabled: isLatex && !readOnly },
  );
  useAppShortcut(
    "underline",
    () => {
      const view = editor.current?.view;
      if (view) toggleLatexCommand("underline")(view);
    },
    { target: container, enabled: isLatex && !readOnly },
  );
  useAppShortcut(
    "format",
    () => {
      const view = editor.current?.view;
      if (view) format(view);
    },
    { target: container, enabled: canFormat && !readOnly },
  );
  const heading = (level: number) => {
    const view = editor.current?.view;
    const command = headingCommands[level];
    if (view && command !== undefined) applyLatexHeading(command)(view);
  };
  useAppShortcut("heading0", () => heading(0), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading1", () => heading(1), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading2", () => heading(2), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading3", () => heading(3), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading4", () => heading(4), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading5", () => heading(5), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading6", () => heading(6), {
    target: container,
    enabled: isLatex && !readOnly,
  });

  useEffect(() => {
    const view = editor.current?.view;
    view?.dispatch({ effects: projectProblemsChanged.of() });
  }, [problems]);

  useEffect(() => {
    const view = editor.current?.view;
    if (!jump || !view) return;
    const line = view.state.doc.line(Math.min(jump.line, view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
  }, [jump]);

  useEffect(() => {
    if (!modified) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [modified]);

  const language = useMemo(
    () =>
      editorLanguage({
        filename: name,
        completion,
        getProblems: () => problemsRef.current ?? [],
        publishSyntax: (next) => syntaxCallback.current?.(next),
      }),
    [name, completion],
  );

  const extensions = useMemo(
    () => [
      ...(collaboration
        ? [
            yCollab(collaboration.text, collaboration.awareness, {
              undoManager: readOnly ? false : (undoManager ?? false),
            }),
            ...(readOnly ? [] : [Prec.highest(keymap.of(yUndoManagerKeymap))]),
          ]
        : []),
      language,
      ...(isMarkdown ? [markdown()] : []),
      EditorView.theme({
        ".cm-content, .cm-gutters": {
          fontFamily: "var(--font-mono)",
          fontSize: `${preferences.fontSize}px`,
        },
        ".cm-scroller": { overflow: "auto" },
      }),
      EditorState.tabSize.of(formatSettings.indent),
      EditorState.transactionFilter.of((transaction) =>
        readOnly &&
        transaction.docChanged &&
        !transaction.annotation(ySyncAnnotation)
          ? []
          : transaction,
      ),
      indentUnit.of(" ".repeat(formatSettings.indent)),
      ...(preferences.wrapLines ? [EditorView.lineWrapping] : []),
      Prec.high(keymap.of([{ key: "Tab", run: acceptCompletion }])),
      keymap.of([
        { key: "Mod-h", mac: "Mod-Shift-h", run: openSearchPanel },
        { key: "Mod-]", run: indentMore },
        { key: "Mod-[", run: indentLess },
      ]),
    ],
    [
      collaboration,
      undoManager,
      preferences,
      readOnly,
      formatSettings.indent,
      isLatex,
      isMarkdown,
      language,
      canFormat,
      format,
    ],
  );

  const commandRef = useRef<(command: EditorCommand) => void>(() => {});
  commandRef.current = (command) => {
    const view = editor.current?.view;
    if (!view) return;
    const selection = view.state.selection.main;
    const copy = async () =>
      navigator.clipboard.writeText(
        view.state.sliceDoc(selection.from, selection.to),
      );
    if (
      readOnly &&
      ["undo", "redo", "format", "cut", "paste", "symbols"].includes(command)
    )
      return;
    switch (command) {
      case "undo":
        runUndo(view);
        break;
      case "redo":
        runRedo(view);
        break;
      case "find":
        openSearchPanel(view);
        break;
      case "format":
        if (canFormat && !formatting) format(view);
        break;
      case "wrap":
        updateEditor({ ...preferences, wrapLines: !preferences.wrapLines });
        break;
      case "symbols":
        if (isLatex) setShowSymbols((open) => !open);
        break;
      case "selectAll":
        view.dispatch({
          selection: { anchor: 0, head: view.state.doc.length },
        });
        break;
      case "copy":
        void copy().catch(() =>
          setError("Clipboard access failed. Use the copy keyboard shortcut."),
        );
        break;
      case "cut":
        void copy()
          .then(() =>
            view.dispatch({
              changes: { from: selection.from, to: selection.to, insert: "" },
            }),
          )
          .catch(() =>
            setError("Clipboard access failed. Use the cut keyboard shortcut."),
          );
        break;
      case "paste":
        void navigator.clipboard
          .readText()
          .then((text) => view.dispatch(view.state.replaceSelection(text)))
          .catch(() =>
            setError(
              "Clipboard access failed. Use the paste keyboard shortcut.",
            ),
          );
        break;
    }
    view.focus();
  };
  useEffect(() => {
    onCommands?.((command) => commandRef.current(command));
    return () => onCommands?.(null);
  }, [onCommands]);

  async function openFile(file: File) {
    const request = ++openRequest.current;
    try {
      const text = await file.text();
      if (request !== openRequest.current) return;
      if (
        modified &&
        !window.confirm(
          "Replace your current source? Download it first to keep your changes.",
        )
      )
        return;
      setName(file.name);
      setDownloadedValue(text);
      setError("");
      const view = editor.current?.view;
      if (view)
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: 0 },
        });
      else {
        setValue(text);
        onChange?.(text);
      }
      view?.focus();
    } catch {
      if (request === openRequest.current)
        setError("Could not read this source file. Try opening it again.");
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div />}
        role="region"
        ref={container}
        aria-label="Source editor"
        className="bg-background flex h-full min-h-0 min-w-0 flex-col"
      >
        <PanelHeader title={name}>
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
              <PanelAction
                label="Open source file"
                onClick={() => fileInput.current?.click()}
              >
                <IconFolderOpen />
              </PanelAction>
            )}
            <PanelAction
              label="Find and replace"
              onClick={() => {
                const view = editor.current?.view;
                if (view) openSearchPanel(view);
              }}
            >
              <IconSearch />
            </PanelAction>
            {isLatex && (
              <PanelAction
                label="LaTeX symbols"
                disabled={readOnly}
                aria-expanded={showSymbols}
                onClick={() => setShowSymbols((open) => !open)}
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
                <DropdownMenuItem
                  disabled={readOnly || !status.undo}
                  onClick={() => commandRef.current("undo")}
                >
                  Undo
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={readOnly || !status.redo}
                  onClick={() => commandRef.current("redo")}
                >
                  Redo
                </DropdownMenuItem>
                {canFormat && (
                  <DropdownMenuItem
                    disabled={readOnly || formatting}
                    onClick={() => commandRef.current("format")}
                  >
                    Format document
                  </DropdownMenuItem>
                )}
                <DropdownMenuCheckboxItem
                  checked={preferences.wrapLines}
                  onCheckedChange={() => commandRef.current("wrap")}
                >
                  Wrap lines
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    downloadFile(
                      new Blob([value], { type: "text/plain;charset=utf-8" }),
                      name,
                    );
                    setDownloadedValue(value);
                  }}
                >
                  Download source
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </PanelActions>
        </PanelHeader>
        {isLatex && !readOnly && showSymbols && (
          <SymbolPalette
            preamble={
              preamble ?? {
                source: value,
                filename: name,
                addPackage: (packageName) => {
                  const view = editor.current?.view;
                  if (view) addLatexPackage(packageName)(view);
                },
              }
            }
            onInsert={(symbol) => {
              const view = editor.current?.view;
              if (view) {
                insertLatexSymbol(symbol)(view);
                view.focus();
              }
            }}
            onClose={() => {
              setShowSymbols(false);
              editor.current?.view?.focus();
            }}
          />
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".tex,.ltx,.bib,.sty,.cls,.md,.markdown,.txt,text/plain,text/markdown"
          className="hidden"
          aria-label="Choose source file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void openFile(file);
          }}
        />
        {(error || formatError) && (
          <p
            role="alert"
            className="text-destructive border-b px-3 py-2 text-xs"
          >
            {error || formatError}
          </p>
        )}
        <CodeMirror
          basicSetup={{ history: !collaboration }}
          readOnly={readOnly}
          editable={!readOnly}
          ref={editor}
          onCreateEditor={(view) => {
            onCreateEditor?.(view);
            const line = view.state.doc.lineAt(view.state.selection.main.head);
            onCursorPosition?.({
              line: line.number,
              column: view.state.selection.main.head - line.from + 1,
            });
          }}
          value={value}
          onChange={(text) => {
            setValue(text);
            onChange?.(text);
          }}
          onUpdate={({ state, selectionSet, docChanged }) => {
            if (selectionSet || docChanged) {
              const line = state.doc.lineAt(state.selection.main.head);
              onCursorPosition?.({
                line: line.number,
                column: state.selection.main.head - line.from + 1,
              });
            }
            const next = {
              undo: undoManager
                ? undoManager.undoStack.length > 0
                : undoDepth(state) > 0,
              redo: undoManager
                ? undoManager.redoStack.length > 0
                : redoDepth(state) > 0,
            };
            setStatus((previous) =>
              previous.undo === next.undo && previous.redo === next.redo
                ? previous
                : next,
            );
          }}
          extensions={extensions}
          height="100%"
          theme={theme.extension}
          placeholder={
            isMarkdown ? "Write your Markdown here…" : "Write your LaTeX here…"
          }
          aria-label={isMarkdown ? "Markdown source" : "LaTeX source"}
          className="min-h-0 flex-1 overflow-hidden [&>.cm-editor]:h-full"
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        {(
          [
            ["cut", "Cut"],
            ["copy", "Copy"],
            ["paste", "Paste"],
            ["selectAll", "Select all"],
            ["undo", "Undo"],
            ["redo", "Redo"],
            ["find", "Find"],
            ["format", "Format document"],
            ["symbols", "Symbol palette"],
          ] satisfies [EditorCommand, string][]
        )
          .filter(
            ([command]) =>
              (command !== "format" || canFormat) &&
              (command !== "symbols" || isLatex),
          )
          .map(([command, title]) => (
            <ContextMenuItem
              key={command}
              disabled={
                (readOnly &&
                  [
                    "undo",
                    "redo",
                    "format",
                    "cut",
                    "paste",
                    "symbols",
                  ].includes(command)) ||
                (command === "undo" && !status.undo) ||
                (command === "redo" && !status.redo)
              }
              onClick={() => commandRef.current(command)}
            >
              {title}
            </ContextMenuItem>
          ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
