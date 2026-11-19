import { useCallback, useMemo, useState } from "react";

import type { LatexProblem } from "#/lib/latex/analysis";

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
      if (JSON.stringify(previous.get(path) ?? []) === JSON.stringify(next))
        return previous;
      return new Map(previous).set(path, next);
    });
  }, []);
  const allProblems = useMemo(
    () => [
      ...analysis,
      ...compile,
      ...[...syntax]
        .filter(([path]) => filenames.includes(path))
        .flatMap(([, problems]) => problems),
    ],
    [analysis, compile, syntax, filenames],
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
