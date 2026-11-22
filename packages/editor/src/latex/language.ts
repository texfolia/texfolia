import type { CompletionSource } from "@codemirror/autocomplete";
import { type Action, type Diagnostic, linter } from "@codemirror/lint";
import { type EditorState, StateEffect } from "@uiw/react-codemirror";
import { latexLinter } from "codemirror-lang-latex";

import type { LatexProblem } from "./analysis";
import { bibtexLanguage, themedLatex } from "./highlight";

export const projectProblemsChanged = StateEffect.define<void>();

export function editorLanguage({
  filename,
  completion,
  getProblems,
  publishSyntax,
  addReference,
}: {
  filename: string;
  completion?: CompletionSource;
  getProblems: () => readonly LatexProblem[];
  publishSyntax: (problems: LatexProblem[]) => void;
  /** Offered as a quick fix for undefined citation keys. */
  addReference?: (key: string) => void;
}) {
  const isLatex = /\.(?:tex|ltx|sty|cls)$/i.test(filename);
  const support = isLatex ? themedLatex(filename) : null;
  const checkSyntax = latexLinter({
    fileName: filename,
    checkMissingDocumentEnv: false,
    checkMissingReferences: !completion,
    checkCitesWithoutBibliography: !completion,
    checkMissingPackages: !completion,
  });

  return [
    ...(support
      ? [
          support,
          ...(completion
            ? [support.language.data.of({ autocomplete: completion })]
            : []),
        ]
      : []),
    ...(/\.bib$/i.test(filename) ? [bibtexLanguage] : []),
    linter(
      (view) => {
        const syntax = isLatex ? checkSyntax(view) : [];
        publishSyntax(
          syntax.map(({ from, to, message, severity }) => ({
            path: filename,
            line: view.state.doc.lineAt(from).number,
            range: { from, to },
            message,
            severity: severity === "hint" ? "info" : severity,
          })),
        );
        return [
          ...syntax,
          ...projectDiagnostics(view.state, getProblems(), addReference),
        ];
      },
      {
        needsRefresh: (update) =>
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) =>
              effect.is(projectProblemsChanged),
            ),
          ),
      },
    ),
  ];
}

function citationActions(
  { key, suggestions }: NonNullable<LatexProblem["citation"]>,
  addReference?: (key: string) => void,
): Action[] {
  const actions: Action[] = suggestions.map((suggestion) => ({
    name: `Use “${suggestion}”`,
    apply(view, from, to) {
      if (view.state.sliceDoc(from, to) === key)
        view.dispatch({ changes: { from, to, insert: suggestion } });
    },
  }));
  if (addReference)
    actions.push({ name: "Add reference…", apply: () => addReference(key) });
  return actions;
}

export function projectDiagnostics(
  state: EditorState,
  problems: readonly LatexProblem[],
  addReference?: (key: string) => void,
): Diagnostic[] {
  const doc = state.doc;
  const editable = !state.readOnly;
  return problems.flatMap(({ line, range, severity, message, citation }) => {
    if (
      range &&
      range.from >= 0 &&
      range.from <= range.to &&
      range.to <= doc.length
    )
      return [
        {
          ...range,
          severity,
          message,
          ...(citation && editable
            ? { actions: citationActions(citation, addReference) }
            : {}),
        },
      ];
    if (range || line < 1 || line > doc.lines) return [];
    const { from, to } = doc.line(line);
    return [{ from, to, severity, message }];
  });
}
