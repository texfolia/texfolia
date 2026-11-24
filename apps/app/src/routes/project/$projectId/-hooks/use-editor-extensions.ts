import {
  acceptCompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { indentLess, indentMore } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { indentUnit } from "@codemirror/language";
import { openSearchPanel } from "@codemirror/search";
import {
  EditorState,
  EditorView,
  type Extension,
  keymap,
  Prec,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  yCollab,
  ySyncAnnotation,
  yUndoManagerKeymap,
} from "y-codemirror.next";

import type { CollaborativeFile } from "#/features/collaboration/browser";
import {
  loadKeymapExtension,
  loadedKeymapExtension,
} from "#/features/editor/keymaps/extension";
import {
  type EditorKeymap,
  editorKeymapLabels,
} from "#/features/editor/keymaps/keymaps";
import type { LatexProblem } from "#/features/editor/latex/analysis";
import {
  editorLanguage,
  projectProblemsChanged,
} from "#/features/editor/latex/language";

export type ScrollAnchor = { pos: number; margin: number };

/**
 * Loads the active keymap lazily and assembles the CodeMirror extension list
 * for collaboration, language support, SyncTeX click-to-reveal, scroll anchor
 * tracking, and formatting/read-only rules.
 */
export function useEditorExtensions({
  editor,
  filename,
  isMarkdown,
  collaboration,
  readOnly,
  keymapPreference,
  fontSize,
  wrapLines,
  indent,
  history,
  commentExtension,
  spellingExtension,
  completion,
  problems,
  onSyntaxProblems,
  onAddReference,
  onRevealPdf,
  scrollAnchor,
  onError,
}: {
  editor: RefObject<ReactCodeMirrorRef | null>;
  filename: string;
  isMarkdown: boolean;
  collaboration?: CollaborativeFile;
  readOnly: boolean;
  keymapPreference: EditorKeymap;
  fontSize: number;
  wrapLines: boolean;
  indent: number;
  history: Extension;
  commentExtension: Extension;
  spellingExtension: Extension;
  completion?: CompletionSource;
  problems?: LatexProblem[];
  onSyntaxProblems?: (problems: LatexProblem[]) => void;
  onAddReference?: (key?: string) => void;
  onRevealPdf?: (line: number) => void;
  scrollAnchor: RefObject<ScrollAnchor | undefined>;
  onError: (message: string) => void;
}) {
  const problemsRef = useRef(problems);
  problemsRef.current = problems;
  const revealPdf = useRef(onRevealPdf);
  revealPdf.current = onRevealPdf;
  const syntaxCallback = useRef(onSyntaxProblems);
  syntaxCallback.current = onSyntaxProblems;
  const addReferenceRef = useRef(onAddReference);
  addReferenceRef.current = onAddReference;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const canAddReference = !!onAddReference;
  const undoManager = collaboration?.undoManager;

  // Vim and Emacs load on first use; the default keys apply until then.
  const [, setKeymapLoads] = useState(0);
  const keymapExtension = loadedKeymapExtension(keymapPreference);
  useEffect(() => {
    if (keymapExtension) return;
    let live = true;
    const label = editorKeymapLabels[keymapPreference];
    loadKeymapExtension(keymapPreference).then(
      () => {
        if (live) setKeymapLoads((count) => count + 1);
      },
      () => {
        if (live)
          onErrorRef.current(
            `${label} keys could not be loaded. Check your connection and reload the page.`,
          );
      },
    );
    return () => {
      live = false;
    };
  }, [keymapPreference, keymapExtension]);

  useEffect(() => {
    editor.current?.view?.dispatch({ effects: projectProblemsChanged.of() });
  }, [editor, problems]);

  const language = useMemo(
    () =>
      editorLanguage({
        filename,
        completion,
        getProblems: () => problemsRef.current ?? [],
        publishSyntax: (next) => syntaxCallback.current?.(next),
        addReference: canAddReference
          ? (key) => addReferenceRef.current?.(key)
          : undefined,
      }),
    [filename, completion, canAddReference],
  );

  return useMemo(
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
          fontSize: `${fontSize}px`,
        },
        ".cm-scroller": { overflow: "auto" },
      }),
      EditorState.tabSize.of(indent),
      EditorState.transactionFilter.of((transaction) =>
        readOnly &&
        transaction.docChanged &&
        !transaction.annotation(ySyncAnnotation)
          ? []
          : transaction,
      ),
      indentUnit.of(" ".repeat(indent)),
      ...(wrapLines ? [EditorView.lineWrapping] : []),
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
      fontSize,
      wrapLines,
      keymapExtension,
      history,
      readOnly,
      indent,
      isMarkdown,
      language,
      spellingExtension,
      commentExtension,
      scrollAnchor,
    ],
  );
}
