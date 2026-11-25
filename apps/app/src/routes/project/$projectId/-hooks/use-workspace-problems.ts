import { useCallback, useMemo, useState } from "react";

import { useStableValue } from "#/hooks/use-stable-value";
import type { LatexProblem } from "#/lib/editor/latex/analysis";

function sameProblem(a: LatexProblem, b: LatexProblem) {
  return (
    a.path === b.path &&
    a.line === b.line &&
    a.message === b.message &&
    a.severity === b.severity &&
    a.range?.from === b.range?.from &&
    a.range?.to === b.range?.to &&
    a.citation?.key === b.citation?.key &&
    a.citation?.suggestions.join("\n") === b.citation?.suggestions.join("\n")
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
  analysis: latestAnalysis,
  compile,
  filenames,
}: {
  analysis: LatexProblem[];
  compile: LatexProblem[];
  filenames: string[];
}) {
  // Each analysis is a new list; most edits leave its problems as they were.
  const analysis = useStableValue(latestAnalysis, sameProblems);
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
