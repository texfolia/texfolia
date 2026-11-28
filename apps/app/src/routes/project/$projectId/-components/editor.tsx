import type { CompletionSource } from "@codemirror/autocomplete";
import { redoDepth, undoDepth } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type { LatexProblem } from "@texfolia/editor";
import { defaultFormatSettings, type FormatSettings } from "@texfolia/editor";
import { addLatexPackage, insertLatexSymbol } from "@texfolia/editor";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@texfolia/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@texfolia/ui/dropdown-menu";
import CodeMirror, {
  type EditorState,
  EditorView,
  type Extension,
  type ReactCodeMirrorRef,
  type ViewUpdate,
} from "@uiw/react-codemirror";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { type Confirmation, ConfirmDialog } from "#/components/confirm-dialog";
import { useEditorTheme } from "#/hooks/use-editor-theme";
import { useLatexFormatter } from "#/hooks/use-latex-formatter";
import { useStableCallback } from "#/hooks/use-stable-callback";
import { documentCachingStopped } from "#/lib/collaboration/browser";
import type { CollaborativeFile } from "#/lib/collaboration/browser";
import type { EditorCommand } from "#/lib/editor/editor-command";
import {
  type EditorJump,
  type EditorSnapshot,
  jumpTo,
  restoreSnapshot,
} from "#/lib/editor/position";
import { selectedLines } from "#/lib/editor/selection";
import { downloadFile } from "#/lib/storage/browser";
import { hasSourcePreview, imageType } from "#/lib/storage/preview";
import { useSettings } from "#/providers/settings-provider";

import { useEditorCommands } from "../-hooks/use-editor-commands";
import {
  type EditorComments,
  useEditorComments,
} from "../-hooks/use-editor-comments";
import { useEditorExtensions } from "../-hooks/use-editor-extensions";
import { useEditorShortcuts } from "../-hooks/use-editor-shortcuts";
import { useEditorSpellcheck } from "../-hooks/use-editor-spellcheck";
import {
  AddCommentAction,
  AddReferenceItem,
  ContextCommand,
  EditorMenuProvider,
  EditorToolbar,
  FindAction,
  MoreActions,
  MoreCommand,
  OpenFileAction,
  PreviewAction,
  SymbolsAction,
  WrapLinesItem,
} from "./editor-menus";
import { SymbolPalette, type SymbolPreambleSource } from "./symbol-palette";

export type { EditorComments, EditorSnapshot };

// Constants, because a new object makes CodeMirror rebuild its extensions.
const standaloneSetup = { history: true };
const collaborativeSetup = { history: false };

type EditorProps = {
  onCursorPosition?: (position: { line: number; column: number }) => void;
  onCommands?: (run: ((command: EditorCommand) => void) | null) => void;
  collaboration?: CollaborativeFile;
  readOnly?: boolean;
  defaultValue?: string;
  savedValue?: string;
  /** Saves itself, so closing the page needs no warning here. */
  autosaved?: boolean;
  filename?: string;
  /** Replaces the file name and wording of a document that is not a file. */
  labels?: {
    title: string;
    region: string;
    source: string;
    placeholder: string;
  };
  onChange?: (value: string) => void;
  onCreateEditor?: (view: EditorView) => void;
  onOpenPreview?: () => void;
  onRevealPdf?: (line: number) => void;
  allowOpenFile?: boolean;
  completion?: CompletionSource;
  extraExtension?: Extension;
  problems?: LatexProblem[];
  onSyntaxProblems?: (problems: LatexProblem[]) => void;
  /** Opens Add reference, for an undefined citation key when one is given. */
  onAddReference?: (key?: string) => void;
  /** Asks the assistant about the selection, or the cursor's line. */
  onAskAi?: (selection: ReturnType<typeof selectedLines>) => void;
  onFixWithAi?: (problem: { line: number; message: string }) => void;
  jump?: EditorJump;
  formatSettings?: FormatSettings;
  preamble?: SymbolPreambleSource;
  comments?: EditorComments;
  // Restored once when the view is created.
  initialSnapshot?: EditorSnapshot;
  // Called when the view is destroyed.
  onSnapshot?: (snapshot: EditorSnapshot) => void;
};

export function Editor({
  onCursorPosition,
  onCommands,
  collaboration,
  readOnly = false,
  defaultValue = "",
  savedValue,
  autosaved = false,
  filename = "main.tex",
  labels,
  onChange,
  onCreateEditor,
  onOpenPreview,
  onRevealPdf,
  allowOpenFile = true,
  completion,
  extraExtension,
  problems,
  onSyntaxProblems,
  onAddReference,
  onAskAi,
  onFixWithAi,
  jump,
  formatSettings = defaultFormatSettings,
  preamble,
  comments,
  initialSnapshot,
  onSnapshot,
}: EditorProps) {
  const theme = useEditorTheme();
  const editor = useRef<ReactCodeMirrorRef>(null);
  const container = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const openRequest = useRef(0);
  // The text the editor starts with. CodeMirror owns it from then on.
  const [initialValue, setInitialValue] = useState(
    () => collaboration?.text.toString() ?? defaultValue,
  );
  const [view, setView] = useState<EditorView | null>(null);
  const docListeners = useRef(new Set<() => void>());
  const [name, setName] = useState(filename);
  const [downloadedValue, setDownloadedValue] = useState(defaultValue);
  const {
    editor: preferences,
    updateEditor,
    spelling,
    addWord,
    spellingLanguage,
  } = useSettings();
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [showSymbols, setShowSymbols] = useState(false);
  const [status, setStatus] = useState({ undo: false, redo: false });
  const undoManager = collaboration?.undoManager;
  const createdView = useRef<EditorView | null>(null);
  const text = () => createdView.current?.state.doc.toString() ?? initialValue;
  const scrollAnchor = useRef(initialSnapshot?.scroll);
  const snapshotCallback = useRef(onSnapshot);
  snapshotCallback.current = onSnapshot;

  useEffect(
    () => () => {
      const state = createdView.current?.state;
      if (!state) return;
      snapshotCallback.current?.({
        anchor: state.selection.main.anchor,
        head: state.selection.main.head,
        scroll: scrollAnchor.current,
      });
    },
    [],
  );

  // Compared when it matters, not with every keystroke.
  const isModified = () => text() !== (savedValue ?? downloadedValue);
  const isLatex = /\.(?:tex|ltx|sty|cls)$/i.test(name);
  const isMarkdown = /\.(?:md|markdown)$/i.test(name);
  const previewLabel = isMarkdown
    ? "Open Markdown preview"
    : imageType(name)
      ? "Open image preview"
      : undefined;
  const canFormat = isLatex || /\.bib$/i.test(name);
  const { format, formatting, formatError } = useLatexFormatter(formatSettings);

  useEditorShortcuts({
    container,
    editor,
    isLatex,
    canFormat,
    readOnly,
    format,
    onOpenPreview: hasSourcePreview(name) ? onOpenPreview : undefined,
  });

  const jumpArrived = useEffectEvent(() => {
    const view = editor.current?.view;
    if (view && jump) jumpTo(view, jump);
  });
  useEffect(() => jumpArrived(), [jump]);

  const warnBeforeUnload = useEffectEvent((event: BeforeUnloadEvent) => {
    if (!documentCachingStopped() && isModified()) event.preventDefault();
  });
  useEffect(() => {
    if (autosaved) return;
    const warn = (event: BeforeUnloadEvent) => warnBeforeUnload(event);
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [autosaved]);

  const {
    canAdd: canAddComment,
    commentExtension,
    addComment,
  } = useEditorComments({
    view,
    collaboration,
    comments,
    onError: setError,
  });

  const { spellingExtension, spellingError } = useEditorSpellcheck({
    editor,
    filename: name,
    words: spelling.words,
    spellingLanguage,
    addWord,
  });

  const { history, runCommand } = useEditorCommands({
    editor,
    undoManager,
    readOnly,
    isLatex,
    canFormat,
    formatting,
    format,
    onToggleWrap: () =>
      void updateEditor({ ...preferences, wrapLines: !preferences.wrapLines }),
    onToggleSymbols: () => setShowSymbols((open) => !open),
    onError: setError,
    onCommands,
  });

  const extensions = useEditorExtensions({
    view,
    filename: name,
    isMarkdown,
    collaboration,
    readOnly,
    keymapPreference: preferences.keymap,
    fontSize: preferences.fontSize,
    wrapLines: preferences.wrapLines,
    indent: formatSettings.indent,
    history,
    commentExtension,
    spellingExtension,
    extraExtension,
    completion,
    problems,
    onSyntaxProblems,
    onAddReference,
    onFixWithAi,
    onRevealPdf,
    scrollAnchor,
    onError: setError,
  });

  // Without a main file, packages load in this one.
  const ownPreamble = useMemo<SymbolPreambleSource>(
    () => ({
      filename: name,
      subscribe(listener) {
        docListeners.current.add(listener);
        return () => {
          docListeners.current.delete(listener);
        };
      },
      getSource: () => createdView.current?.state.doc.toString() ?? "",
      addPackage(packageName) {
        const view = createdView.current;
        if (view) addLatexPackage(packageName)(view);
      },
    }),
    [name],
  );

  const viewCreated = useStableCallback((view: EditorView) => {
    createdView.current = view;
    setView(view);
    if (initialSnapshot) restoreSnapshot(view, initialSnapshot);
    // Files connect when opened, so a jump can precede the editor.
    if (jump) jumpTo(view, jump);
    onCreateEditor?.(view);
    reportPosition(view.state);
  });
  function reportPosition(state: EditorState) {
    const { head } = state.selection.main;
    const line = state.doc.lineAt(head);
    onCursorPosition?.({ line: line.number, column: head - line.from + 1 });
  }
  const viewUpdated = useStableCallback((update: ViewUpdate) => {
    const { state, selectionSet, docChanged, changes } = update;
    if (docChanged && scrollAnchor.current)
      scrollAnchor.current = {
        ...scrollAnchor.current,
        pos: changes.mapPos(scrollAnchor.current.pos, -1),
      };
    if (selectionSet || docChanged) reportPosition(state);
    if (docChanged) for (const listener of docListeners.current) listener();
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
  });
  const changed = useStableCallback((text: string) => onChange?.(text));

  function askAi() {
    const view = editor.current?.view;
    if (view) onAskAi?.(selectedLines(view.state));
  }

  function find() {
    const view = editor.current?.view;
    if (view) openSearchPanel(view);
  }

  function revealLine() {
    const view = editor.current?.view;
    if (view)
      onRevealPdf?.(
        view.state.doc.lineAt(view.state.selection.main.head).number,
      );
  }

  function download() {
    const source = text();
    downloadFile(
      new Blob([source], { type: "text/plain;charset=utf-8" }),
      name,
    );
    setDownloadedValue(source);
  }

  function replaceSource(filename: string, source: string) {
    setName(filename);
    setDownloadedValue(source);
    setError("");
    const view = editor.current?.view;
    if (view)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: source },
        selection: { anchor: 0 },
      });
    else {
      setInitialValue(source);
      onChange?.(source);
    }
    view?.focus();
  }

  async function openFile(file: File) {
    const request = ++openRequest.current;
    try {
      const source = await file.text();
      if (request !== openRequest.current) return;
      if (!isModified()) {
        replaceSource(file.name, source);
        return;
      }
      setConfirmation({
        title: "Replace your current source?",
        description: "Download it first to keep your changes.",
        action: "Replace source",
        onConfirm: () => replaceSource(file.name, source),
      });
    } catch {
      if (request === openRequest.current)
        setError("Could not read this source file. Try opening it again.");
    }
  }

  return (
    <EditorMenuProvider
      readOnly={readOnly}
      formatting={formatting}
      status={status}
      run={runCommand}
    >
      <ContextMenu>
        <ContextMenuTrigger
          render={<div />}
          role="region"
          ref={container}
          aria-label={labels?.region ?? "Source editor"}
          className="bg-background flex h-full min-h-0 min-w-0 flex-col"
        >
          <EditorToolbar title={labels?.title ?? name}>
            {onOpenPreview && previewLabel && (
              <PreviewAction label={previewLabel} onClick={onOpenPreview} />
            )}
            {allowOpenFile && (
              <OpenFileAction onClick={() => fileInput.current?.click()} />
            )}
            {canAddComment && <AddCommentAction onClick={addComment} />}
            <FindAction onClick={find} />
            {isLatex && (
              <SymbolsAction
                expanded={showSymbols}
                onClick={() => setShowSymbols((open) => !open)}
              />
            )}
            <MoreActions>
              {onRevealPdf && (
                <DropdownMenuItem onClick={revealLine}>
                  Reveal in PDF
                </DropdownMenuItem>
              )}
              <MoreCommand command="undo">Undo</MoreCommand>
              <MoreCommand command="redo">Redo</MoreCommand>
              {onAskAi && (
                <DropdownMenuItem onClick={askAi}>
                  Ask AI about selection
                </DropdownMenuItem>
              )}
              {onAddReference && canFormat && (
                <AddReferenceItem onClick={() => onAddReference()} />
              )}
              {canFormat && (
                <MoreCommand command="format">Format document</MoreCommand>
              )}
              <WrapLinesItem checked={preferences.wrapLines} />
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={download}>
                Download source
              </DropdownMenuItem>
            </MoreActions>
          </EditorToolbar>
          {isLatex && !readOnly && showSymbols && (
            <SymbolPalette
              preamble={preamble ?? ownPreamble}
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
          {(error || formatError || spellingError) && (
            <p
              role="alert"
              className="text-destructive border-b px-3 py-2 text-xs"
            >
              {error || formatError || spellingError}
            </p>
          )}
          <CodeMirror
            basicSetup={collaboration ? collaborativeSetup : standaloneSetup}
            readOnly={readOnly}
            editable={!readOnly}
            ref={editor}
            onCreateEditor={viewCreated}
            value={initialValue}
            // Reading the text costs its whole length, so only when it is used.
            onChange={onChange ? changed : undefined}
            onUpdate={viewUpdated}
            extensions={extensions}
            height="100%"
            theme={theme}
            placeholder={
              labels?.placeholder ??
              (isMarkdown
                ? "Write your Markdown here…"
                : "Write your LaTeX here…")
            }
            aria-label={
              labels?.source ??
              (isMarkdown ? "Markdown source" : "LaTeX source")
            }
            className="min-h-0 flex-1 overflow-hidden [&>.cm-editor]:h-full"
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          {onAskAi && (
            <ContextMenuItem onClick={askAi}>
              Ask AI about selection
            </ContextMenuItem>
          )}
          {canAddComment && (
            <ContextMenuItem onClick={addComment}>Add comment</ContextMenuItem>
          )}
          <ContextCommand command="cut">Cut</ContextCommand>
          <ContextCommand command="copy">Copy</ContextCommand>
          <ContextCommand command="paste">Paste</ContextCommand>
          <ContextCommand command="selectAll">Select all</ContextCommand>
          <ContextCommand command="undo">Undo</ContextCommand>
          <ContextCommand command="redo">Redo</ContextCommand>
          <ContextCommand command="find">Find</ContextCommand>
          {canFormat && (
            <ContextCommand command="format">Format document</ContextCommand>
          )}
          {isLatex && (
            <ContextCommand command="symbols">Symbol palette</ContextCommand>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <ConfirmDialog
        confirmation={confirmation}
        onClose={() => setConfirmation(null)}
        finalFocus={() => editor.current?.view?.contentDOM}
      />
    </EditorMenuProvider>
  );
}
