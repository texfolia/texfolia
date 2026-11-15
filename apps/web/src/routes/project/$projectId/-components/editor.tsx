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
  IconArrowBackUp,
  IconArrowForwardUp,
  IconDownload,
  IconEye,
  IconFolderOpen,
  IconSearch,
  IconMathSymbols,
  IconTextWrap,
  IconWand,
} from "@tabler/icons-react";
import { useHotkeys } from "@tanstack/react-hotkeys";
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
import { useLatexFormatter } from "#/hooks/use-latex-formatter";
import type { CollaborativeFile } from "#/lib/collaboration/file";
import { downloadFile } from "#/lib/download-file";
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
import { useTheme } from "#/providers/theme-provider";

import { SymbolPalette, type SymbolPreamble } from "./symbol-palette";

type EditorProps = {
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
  const container = useRef<HTMLElement>(null);
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

  useHotkeys([{ hotkey: "Mod+Shift+V", callback: () => onOpenPreview?.() }], {
    target: container,
    capture: true,
    ignoreInputs: false,
    enabled: isMarkdown && !!onOpenPreview,
  });

  useHotkeys(
    [
      {
        hotkey: "Mod+I",
        callback: () => {
          const view = editor.current?.view;
          if (view) toggleLatexCommand("textit")(view);
        },
      },
      {
        hotkey: "Mod+U",
        callback: () => {
          const view = editor.current?.view;
          if (view) toggleLatexCommand("underline")(view);
        },
      },
      ...headingCommands.map((command, level) => ({
        hotkey: { code: `Digit${level}`, mod: true, alt: true },
        callback: () => {
          const view = editor.current?.view;
          if (view) applyLatexHeading(command)(view);
        },
      })),
    ],
    {
      target: container,
      capture: true,
      ignoreInputs: false,
      enabled: isLatex && !readOnly,
    },
  );

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
      Prec.high(
        keymap.of([
          { key: "Tab", run: acceptCompletion },
          ...(isLatex && !readOnly
            ? [{ key: "Mod-b", run: toggleLatexCommand("textbf") }]
            : []),
        ]),
      ),
      keymap.of([
        ...(canFormat && !readOnly
          ? [{ key: "Mod-Shift-f", run: format }]
          : []),
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
    <section
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
            label="Download source"
            onClick={() => {
              downloadFile(
                new Blob([value], { type: "text/plain;charset=utf-8" }),
                name,
              );
              setDownloadedValue(value);
            }}
          >
            <IconDownload />
          </PanelAction>
          <PanelAction
            label="Undo"
            disabled={readOnly || !status.undo}
            onClick={() => {
              const view = editor.current?.view;
              if (view) {
                runUndo(view);
                view.focus();
              }
            }}
          >
            <IconArrowBackUp />
          </PanelAction>
          <PanelAction
            label="Redo"
            disabled={readOnly || !status.redo}
            onClick={() => {
              const view = editor.current?.view;
              if (view) {
                runRedo(view);
                view.focus();
              }
            }}
          >
            <IconArrowForwardUp />
          </PanelAction>
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
          {canFormat && (
            <PanelAction
              label="Format document (⌘/Ctrl+Shift+F)"
              disabled={readOnly || formatting}
              onClick={() => {
                const view = editor.current?.view;
                if (view) {
                  format(view);
                  view.focus();
                }
              }}
            >
              <IconWand />
            </PanelAction>
          )}
          <PanelAction
            label="Wrap lines"
            aria-pressed={preferences.wrapLines}
            onClick={() =>
              updateEditor({
                ...preferences,
                wrapLines: !preferences.wrapLines,
              })
            }
          >
            <IconTextWrap />
          </PanelAction>
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
        <p role="alert" className="text-destructive border-b px-3 py-2 text-xs">
          {error || formatError}
        </p>
      )}
      <CodeMirror
        basicSetup={{ history: !collaboration }}
        readOnly={readOnly}
        editable={!readOnly}
        ref={editor}
        onCreateEditor={onCreateEditor}
        value={value}
        onChange={(text) => {
          setValue(text);
          onChange?.(text);
        }}
        onUpdate={({ state }) => {
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
    </section>
  );
}
