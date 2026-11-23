import { useCallback, useMemo, useState } from "react";

import type { LatexProblem } from "#/features/editor/latex/analysis";

function sameProblem(a: LatexProblem, b: LatexProblem) {
  return (
    a.path === b.path &&
    a.line === b.line &&
    a.message === b.message &&
    a.severity === b.severity &&
    a.range?.from === b.range?.from &&
    a.range?.to === b.range?.to
  );
}

function sameProblems(a: readonly LatexProblem[], b: readonly LatexProblem[]) {
  return (
    a.length === b.length &&
    a.every((problem, index) => sameProblem(problem, b[index]!))
  );
}

/**
 * Merges analysis, compile-log and editor syntax problems. Syntax problems
 * of files no longer in the project are dropped.
 */
export function useWorkspaceProblems({
  analysis,
  compile,
  filenames,
}: {
  analysis: LatexProblem[];
  compile: LatexProblem[];
  filenames: string[];
}) {
  const [syntax, setSyntax] = useState(new Map<string, LatexProblem[]>());
  const reportSyntax = useCallback((path: string, problems: LatexProblem[]) => {
    const next = problems.map((problem) => ({ ...problem, path }));
    setSyntax((previous) => {
      if (sameProblems(previous.get(path) ?? [], next)) return previous;
      return new Map(previous).set(path, next);
    });
  }, []);
  const filenameSet = useMemo(() => new Set(filenames), [filenames]);
  const allProblems = useMemo(
    () => [
      ...analysis,
      ...compile,
      ...[...syntax]
        .filter(([path]) => filenameSet.has(path))
        .flatMap(([, problems]) => problems),
    ],
    [analysis, compile, syntax, filenameSet],
  );
  // Editors show their own syntax problems; these are the rest, by file.
  const problems = useMemo(() => {
    const byPath = new Map<string, LatexProblem[]>();
    for (const problem of [...analysis, ...compile]) {
      const list = byPath.get(problem.path) ?? [];
      list.push(problem);
      byPath.set(problem.path, list);
    }
    return byPath;
  }, [analysis, compile]);
  return { problems, allProblems, reportSyntax };
}
