import type { CompletionSource } from "@codemirror/autocomplete";
import { type Diagnostic, linter } from "@codemirror/lint";
import { type EditorView, StateEffect } from "@uiw/react-codemirror";
import { latex, latexLanguage, latexLinter } from "codemirror-lang-latex";

import type { LatexProblem } from "./analysis";

export const projectProblemsChanged = StateEffect.define<void>();

export function editorLanguage({
  filename,
  completion,
  getProblems,
  publishSyntax,
}: {
  filename: string;
  completion?: CompletionSource;
  getProblems: () => readonly LatexProblem[];
  publishSyntax: (problems: LatexProblem[]) => void;
}) {
  const isLatex = /\.(?:tex|ltx|sty|cls)$/i.test(filename);
  const checkSyntax = latexLinter({
    fileName: filename,
    checkMissingDocumentEnv: false,
    checkMissingReferences: !completion,
    checkCitesWithoutBibliography: !completion,
    checkMissingPackages: !completion,
  });

  return [
    ...(isLatex
      ? [
          // Use language data so upstream and project completions can coexist.
          latex({
            fileName: filename,
            enableLinting: false,
            enableAutocomplete: false,
          }),
          ...(completion
            ? [latexLanguage.data.of({ autocomplete: completion })]
            : []),
        ]
      : []),
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
        return [...syntax, ...projectDiagnostics(view, getProblems())];
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

function projectDiagnostics(
  view: EditorView,
  problems: readonly LatexProblem[],
): Diagnostic[] {
  const doc = view.state.doc;
  return problems.flatMap(({ line, range, severity, message }) => {
    if (
      range &&
      range.from >= 0 &&
      range.from <= range.to &&
      range.to <= doc.length
    )
      return [{ ...range, severity, message }];
    if (range || line < 1 || line > doc.lines) return [];
    const { from, to } = doc.line(line);
    return [{ from, to, severity, message }];
  });
}
