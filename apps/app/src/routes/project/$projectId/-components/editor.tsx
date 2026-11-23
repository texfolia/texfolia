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
  IconMessagePlus,
} from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@texfolia/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@texfolia/ui/dropdown-menu";
import CodeMirror, {
  EditorState,
  EditorView,
  keymap,
  Prec,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  yCollab,
  ySyncAnnotation,
  yUndoManagerKeymap,
} from "y-codemirror.next";

import {
  PanelAction,
  PanelActions,
  PanelHeader,
} from "#/components/panel-header";
import { documentCachingStopped } from "#/features/collaboration/browser";
import type { CollaborativeFile } from "#/features/collaboration/browser";
import {
  type CommentAnchor,
  createCommentAnchor,
  resolveCommentAnchor,
} from "#/features/comments/anchor";
import {
  commentRanges,
  type CommentRange,
  setCommentRanges,
} from "#/features/comments/editor";
import { commentQuote } from "#/features/comments/project-comments.schema";
import type { EditorCommand } from "#/features/editor/editor-command";
import {
  keymapHistory,
  loadKeymapExtension,
  loadedKeymapExtension,
} from "#/features/editor/keymaps/extension";
import { editorKeymapLabels } from "#/features/editor/keymaps/keymaps";
import type { LatexProblem } from "#/features/editor/latex/analysis";
import {
  applyLatexHeading,
  headingCommands,
  toggleLatexCommand,
} from "#/features/editor/latex/editor-commands";
import {
  defaultFormatSettings,
  type FormatSettings,
} from "#/features/editor/latex/format";
import {
  editorLanguage,
  projectProblemsChanged,
} from "#/features/editor/latex/language";
import {
  addLatexPackage,
  insertLatexSymbol,
} from "#/features/editor/latex/symbols";
import { browserSpellChecker } from "#/features/editor/spelling/checker";
import {
  personalDictionaryChanged,
  spellcheck,
} from "#/features/editor/spelling/editor";
import { personalDictionaryHas } from "#/features/settings/settings.schema";
import { downloadFile } from "#/features/storage/browser";
import { useLatexFormatter } from "#/hooks/use-latex-formatter";
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
  onRevealPdf?: (line: number) => void;
  allowOpenFile?: boolean;
  completion?: CompletionSource;
  problems?: LatexProblem[];
  onSyntaxProblems?: (problems: LatexProblem[]) => void;
  /** Opens Add reference, for an undefined citation key when one is given. */
  onAddReference?: (key?: string) => void;
  jump?: {
    line: number;
    column?: number;
    length?: number;
    // Scrolls to this range without moving the selection or focus.
    range?: { from: number; to: number };
  };
  formatSettings?: FormatSettings;
  preamble?: SymbolPreamble;
  comments?: EditorComments;
  // Restored once when the view is created.
  initialSnapshot?: EditorSnapshot;
  // Called when the view is destroyed.
  onSnapshot?: (snapshot: EditorSnapshot) => void;
};

// Selection and scroll position, as document offsets. The scroll anchor is the
// first visible line and how far its top sits above the viewport.
export type EditorSnapshot = {
  anchor: number;
  head: number;
  scroll?: { pos: number; margin: number };
};

export type EditorComments = {
  threads: (CommentAnchor & { id: string })[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onAdd: (draft: CommentAnchor & { quote: string }) => void;
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
  onRevealPdf,
  allowOpenFile = true,
  completion,
  problems,
  onSyntaxProblems,
  onAddReference,
  jump,
  formatSettings = defaultFormatSettings,
  preamble,
  comments,
  initialSnapshot,
  onSnapshot,
}: EditorProps) {
  const { theme } = useTheme();
  const editor = useRef<ReactCodeMirrorRef>(null);
  const problemsRef = useRef(problems);
  problemsRef.current = problems;
  const revealPdf = useRef(onRevealPdf);
  revealPdf.current = onRevealPdf;
  const syntaxCallback = useRef(onSyntaxProblems);
  syntaxCallback.current = onSyntaxProblems;
  const addReferenceRef = useRef(onAddReference);
  addReferenceRef.current = onAddReference;
  const canAddReference = !!onAddReference;
  const container = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const openRequest = useRef(0);
  const [value, setValue] = useState(defaultValue);
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
  const [spellingError, setSpellingError] = useState("");
  const [showSymbols, setShowSymbols] = useState(false);
  const [status, setStatus] = useState({
    undo: false,
    redo: false,
  });
  const undoManager = collaboration?.undoManager;
  const createdView = useRef<EditorView | null>(null);
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
  const runUndo = (view: EditorView) =>
    undoManager ? undoManager.undo() : undo(view);
  const runRedo = (view: EditorView) =>
    undoManager ? undoManager.redo() : redo(view);
  const history = useMemo(
    () =>
      keymapHistory.of({
        undo: (view) => (undoManager ? undoManager.undo() : undo(view)),
        redo: (view) => (undoManager ? undoManager.redo() : redo(view)),
      }),
    [undoManager],
  );
  // Vim and Emacs load on first use; the default keys apply until then.
  const [, setKeymapLoads] = useState(0);
  const keymapExtension = loadedKeymapExtension(preferences.keymap);
  useEffect(() => {
    if (keymapExtension) return;
    let live = true;
    const label = editorKeymapLabels[preferences.keymap];
    loadKeymapExtension(preferences.keymap).then(
      () => {
        if (live) setKeymapLoads((count) => count + 1);
      },
      () => {
        if (live)
          setError(
            `${label} keys could not be loaded. Check your connection and reload the page.`,
          );
      },
    );
    return () => {
      live = false;
    };
  }, [preferences.keymap, keymapExtension]);
  const modified = value !== (savedValue ?? downloadedValue);
  const isLatex = /\.(?:tex|ltx|sty|cls)$/i.test(name);
  const isMarkdown = /\.(?:md|markdown)$/i.test(name);
  // Packages and classes are code, so only documents are spell checked.
  const checksSpelling =
    /\.(?:tex|ltx)$/i.test(name) &&
    !!spellingLanguage &&
    spellingLanguage !== "off";
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

  function applyJump(view: EditorView) {
    if (!jump) return;
    if (jump.range) {
      const from = Math.min(jump.range.from, view.state.doc.length);
      view.dispatch({
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });
      return;
    }
    const line = view.state.doc.line(Math.min(jump.line, view.state.doc.lines));
    const anchor = line.from + Math.min((jump.column ?? 1) - 1, line.length);
    view.dispatch({
      selection: {
        anchor,
        head: Math.min(anchor + (jump.length ?? 0), line.to),
      },
      scrollIntoView: true,
    });
    view.focus();
  }
  const jumpArrived = useEffectEvent(() => {
    const view = editor.current?.view;
    if (view) applyJump(view);
  });
  useEffect(() => jumpArrived(), [jump]);

  useEffect(() => {
    if (!modified) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (!documentCachingStopped()) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [modified]);

  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const commenting = !!comments && !!collaboration;
  const commentExtension = useMemo(
    () =>
      commenting
        ? commentRanges((id) => commentsRef.current?.onSelect(id))
        : [],
    [commenting],
  );
  const commentThreads = comments?.threads;
  const activeCommentId = comments?.activeId;
  // Resolves anchors against the shared document. An anchor stays unresolved
  // until its author's edits arrive, so retry on document updates until all
  // resolve.
  useEffect(() => {
    if (!collaboration || !commentThreads) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      const view = editor.current?.view;
      if (!view) return true;
      const ranges: CommentRange[] = [];
      let unresolved = false;
      for (const thread of commentThreads) {
        const range = resolveCommentAnchor(collaboration.text, thread);
        if (range) ranges.push({ id: thread.id, ...range });
        else unresolved = true;
      }
      view.dispatch({
        effects: setCommentRanges.of({ ranges, activeId: activeCommentId }),
      });
      return unresolved;
    };
    if (!apply()) return;
    const retry = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!apply()) collaboration.doc.off("update", retry);
      }, 250);
    };
    collaboration.doc.on("update", retry);
    return () => {
      clearTimeout(timer);
      collaboration.doc.off("update", retry);
    };
  }, [collaboration, commentThreads, activeCommentId, commentExtension]);

  function addComment() {
    const view = editor.current?.view;
    if (!view || !collaboration || !comments) return;
    let { from, to } = view.state.selection.main;
    // Without a selection, comment on the cursor's line.
    if (from === to) ({ from, to } = view.state.doc.lineAt(from));
    if (from === to) {
      setError("Select the text you want to comment on.");
      return;
    }
    setError("");
    comments.onAdd({
      ...createCommentAnchor(collaboration.text, from, to),
      quote: commentQuote(view.state.sliceDoc(from, to)),
    });
  }

  const personalWords = useMemo(
    () => new Set(spelling.words),
    [spelling.words],
  );
  const personalWordsRef = useRef(personalWords);
  personalWordsRef.current = personalWords;
  const addWordRef = useRef(addWord);
  addWordRef.current = addWord;
  const spellingExtension = useMemo(
    () =>
      checksSpelling && spellingLanguage
        ? spellcheck({
            language: spellingLanguage,
            checker: browserSpellChecker(),
            isKnown: (word) =>
              personalDictionaryHas(personalWordsRef.current, word),
            // The personal dictionary belongs to the user, so viewers can add.
            addWord: (word) => void addWordRef.current(word),
            onError: setSpellingError,
          })
        : [],
    [checksSpelling, spellingLanguage],
  );
  useEffect(() => {
    setSpellingError("");
  }, [spellingExtension]);
  useEffect(() => {
    editor.current?.view?.dispatch({
      effects: personalDictionaryChanged.of(),
    });
  }, [personalWords]);

  const language = useMemo(
    () =>
      editorLanguage({
        filename: name,
        completion,
        getProblems: () => problemsRef.current ?? [],
        publishSyntax: (next) => syntaxCallback.current?.(next),
        addReference: canAddReference
          ? (key) => addReferenceRef.current?.(key)
          : undefined,
      }),
    [name, completion, canAddReference],
  );

  const extensions = useMemo(
    () => [
      keymapExtension ?? [],
      history,
      ...(collaboration
        ? [
            yCollab(collaboration.text, collaboration.awareness, {
              undoManager: readOnly ? false : (undoManager ?? false),
            }),
            ...(readOnly ? [] : [Prec.highest(keymap.of(yUndoManagerKeymap))]),
          ]
        : []),
      EditorView.domEventHandlers({
        // Read while attached: a detached scroller reports a scrollTop of 0.
        scroll(_event, view) {
          if (!view.dom.isConnected) return false;
          const top = view.scrollDOM.scrollTop - view.documentPadding.top;
          const block = view.lineBlockAtHeight(Math.max(0, top));
          scrollAnchor.current = { pos: block.from, margin: block.top - top };
          return false;
        },
        mousedown(event, view) {
          if (
            event.button !== 0 ||
            !(event.metaKey || event.ctrlKey) ||
            !revealPdf.current
          )
            return false;
          const position = view.posAtCoords({
            x: event.clientX,
            y: event.clientY,
          });
          if (position === null) return false;
          event.preventDefault();
          revealPdf.current(view.state.doc.lineAt(position).number);
          return true;
        },
      }),
      commentExtension,
      language,
      spellingExtension,
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
      keymapExtension,
      history,
      readOnly,
      formatSettings.indent,
      isLatex,
      isMarkdown,
      language,
      spellingExtension,
      canFormat,
      format,
      commentExtension,
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
            {commenting && (
              <PanelAction label="Add comment" onClick={addComment}>
                <IconMessagePlus />
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
                {onRevealPdf && (
                  <DropdownMenuItem
                    onClick={() => {
                      const view = editor.current?.view;
                      if (view)
                        onRevealPdf(
                          view.state.doc.lineAt(view.state.selection.main.head)
                            .number,
                        );
                    }}
                  >
                    Reveal in PDF
                  </DropdownMenuItem>
                )}
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
                {onAddReference && (isLatex || /\.bib$/i.test(name)) && (
                  <DropdownMenuItem
                    disabled={readOnly}
                    onClick={() => onAddReference()}
                  >
                    Add reference…
                  </DropdownMenuItem>
                )}
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
        {(error || formatError || spellingError) && (
          <p
            role="alert"
            className="text-destructive border-b px-3 py-2 text-xs"
          >
            {error || formatError || spellingError}
          </p>
        )}
        <CodeMirror
          basicSetup={{ history: !collaboration }}
          readOnly={readOnly}
          editable={!readOnly}
          ref={editor}
          onCreateEditor={(view) => {
            createdView.current = view;
            if (initialSnapshot) {
              const clamp = (position: number) =>
                Math.min(Math.max(position, 0), view.state.doc.length);
              const { scroll } = initialSnapshot;
              view.dispatch({
                selection: {
                  anchor: clamp(initialSnapshot.anchor),
                  head: clamp(initialSnapshot.head),
                },
                effects: scroll
                  ? EditorView.scrollIntoView(clamp(scroll.pos), {
                      y: "start",
                      yMargin: scroll.margin,
                    })
                  : undefined,
                scrollIntoView: !scroll,
              });
            }
            // Files connect when opened, so a jump can precede the editor.
            applyJump(view);
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
          onUpdate={({ state, selectionSet, docChanged, changes }) => {
            if (docChanged && scrollAnchor.current)
              scrollAnchor.current = {
                ...scrollAnchor.current,
                pos: changes.mapPos(scrollAnchor.current.pos, -1),
              };
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
        {commenting && (
          <ContextMenuItem onClick={addComment}>Add comment</ContextMenuItem>
        )}
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
