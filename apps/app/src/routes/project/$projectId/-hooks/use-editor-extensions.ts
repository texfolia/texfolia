import {
  acceptCompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { indentLess, indentMore } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { openSearchPanel } from "@codemirror/search";
import {
  Compartment,
  EditorState,
  EditorView,
  type Extension,
  keymap,
  Prec,
} from "@uiw/react-codemirror";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  yCollab,
  ySyncAnnotation,
  yUndoManagerKeymap,
} from "y-codemirror.next";

import type { CollaborativeFile } from "#/lib/collaboration/browser";
import {
  loadKeymapExtension,
  loadedKeymapExtension,
} from "#/lib/editor/keymaps/extension";
import {
  type EditorKeymap,
  editorKeymapLabels,
} from "#/lib/editor/keymaps/keymaps";
import type { LatexProblem } from "#/lib/editor/latex/analysis";
import {
  editorLanguage,
  projectProblemsChanged,
} from "#/lib/editor/latex/language";
import { markdownSupport } from "#/lib/editor/markdown";
import type { ScrollAnchor } from "#/lib/editor/position";

const none: Extension = [];

// Blocks edits from this editor; collaborators' edits still arrive.
const blockEdits = [
  EditorState.transactionFilter.of((transaction) =>
    transaction.docChanged && !transaction.annotation(ySyncAnnotation)
      ? []
      : transaction,
  ),
  // The collaboration binding undoes from this event without a transaction.
  Prec.highest(
    EditorView.domEventHandlers({
      beforeinput: (event) => event.inputType.startsWith("history"),
    }),
  ),
];
const undoKeymap = Prec.highest(keymap.of(yUndoManagerKeymap));

/** Extensions that change while an editor is open, in order of precedence. */
type Dynamic = {
  keymap: Extension;
  history: Extension;
  collaboration: Extension;
  editing: Extension;
  comments: Extension;
  language: Extension;
  spelling: Extension;
  markdown: Extension;
  font: Extension;
  indent: Extension;
  wrapping: Extension;
};
type Compartments = Record<keyof Dynamic, Compartment>;

/**
 * Keeps each extension in a compartment, so a change reconfigures only its own.
 * The returned list never changes, because CodeMirror rebuilds every extension
 * of a list that does.
 */
function useCompartments(
  view: EditorView | null,
  dynamic: Dynamic,
  fixed: () => Extension[],
) {
  const [{ compartments, extensions }] = useState(() => {
    const entries = Object.entries(dynamic).map(
      ([name, extension]) => [name, extension, new Compartment()] as const,
    );
    return {
      compartments: Object.fromEntries(
        entries.map(([name, , compartment]) => [name, compartment]),
      ) as Compartments,
      extensions: [
        ...entries.map(([, extension, compartment]) =>
          compartment.of(extension),
        ),
        ...fixed(),
      ],
    };
  });
  // Before passive effects, which dispatch to the extensions, such as comments.
  useLayoutEffect(() => {
    if (!view) return;
    const effects = Object.entries(compartments).flatMap(
      ([name, compartment]) => {
        const extension = dynamic[name as keyof Dynamic];
        return compartment.get(view.state) === extension
          ? []
          : [compartment.reconfigure(extension)];
      },
    );
    if (effects.length) view.dispatch({ effects });
  });
  return extensions;
}

/**
 * Loads the active keymap lazily and assembles the CodeMirror extensions for
 * collaboration, language support, SyncTeX click-to-reveal, scroll anchor
 * tracking, and formatting/read-only rules.
 */
export function useEditorExtensions({
  view,
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
  onFixWithAi,
  onRevealPdf,
  scrollAnchor,
  onError,
}: {
  view: EditorView | null;
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
  onFixWithAi?: (problem: { line: number; message: string }) => void;
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
  const fixWithAiRef = useRef(onFixWithAi);
  fixWithAiRef.current = onFixWithAi;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const canAddReference = !!onAddReference;
  const canFixWithAi = !!onFixWithAi;

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
    view?.dispatch({ effects: projectProblemsChanged.of() });
  }, [view, problems]);

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
        fixWithAi: canFixWithAi
          ? (problem) => fixWithAiRef.current?.(problem)
          : undefined,
      }),
    [filename, completion, canAddReference, canFixWithAi],
  );

  // Its plugins keep the configuration they were created with, so this must
  // stay the same for the document, whatever else changes. Otherwise undo would
  // follow edits of a configuration that the text binding does not use.
  const binding = useMemo(
    () =>
      collaboration
        ? yCollab(collaboration.text, collaboration.awareness, {
            undoManager: collaboration.undoManager,
          })
        : none,
    [collaboration],
  );
  const font = useMemo(
    () =>
      EditorView.theme({
        ".cm-content, .cm-gutters": {
          fontFamily: "var(--font-mono)",
          fontSize: `${fontSize}px`,
        },
      }),
    [fontSize],
  );
  const indentation = useMemo(
    () => [EditorState.tabSize.of(indent), indentUnit.of(" ".repeat(indent))],
    [indent],
  );
  const markdown = useMemo(
    () => (isMarkdown ? markdownSupport() : none),
    [isMarkdown],
  );

  return useCompartments(
    view,
    {
      keymap: keymapExtension ?? none,
      history,
      collaboration: binding,
      editing: readOnly ? blockEdits : collaboration ? undoKeymap : none,
      comments: commentExtension,
      language,
      spelling: spellingExtension,
      markdown,
      font,
      indent: indentation,
      wrapping: wrapLines ? EditorView.lineWrapping : none,
    },
    () => [
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
      EditorView.theme({ ".cm-scroller": { overflow: "auto" } }),
      Prec.high(keymap.of([{ key: "Tab", run: acceptCompletion }])),
      keymap.of([
        { key: "Mod-h", mac: "Mod-Shift-h", run: openSearchPanel },
        { key: "Mod-]", run: indentMore },
        { key: "Mod-[", run: indentLess },
      ]),
    ],
  );
}
