import { latexCompletion } from "@texfolia/editor";
import { useMemo } from "react";

import { useLatexAnalysis } from "#/hooks/use-latex-analysis";
import { useStableCallback } from "#/hooks/use-stable-callback";
import { useStableValue } from "#/hooks/use-stable-value";
import {
  type ProjectNode,
  projectMainFile,
  projectPaths,
} from "#/lib/projects";

function samePaths(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
) {
  if (a.size !== b.size) return false;
  const other = b.entries();
  for (const [id, path] of a) {
    const entry = other.next().value;
    if (entry?.[0] !== id || entry[1] !== path) return false;
  }
  return true;
}

/** The project's files by path, and what their LaTeX sources define. */
export function useProjectDocuments(
  nodes: ProjectNode[],
  chosenMain: string | null,
) {
  // Nodes are new objects after each refresh; their paths rarely change.
  const paths = useStableValue(
    useMemo(() => projectPaths(nodes), [nodes]),
    samePaths,
  );
  const filenames = useMemo(() => [...paths.values()], [paths]);
  const mainFile = useMemo(
    () => projectMainFile(paths, chosenMain),
    [paths, chosenMain],
  );
  const { result, update, revision } = useLatexAnalysis(
    filenames,
    mainFile?.path,
  );
  const readAnalysis = useStableCallback(() => result.analysis);
  const completion = useMemo(
    () => latexCompletion(readAnalysis, filenames),
    [readAnalysis, filenames],
  );
  return { paths, filenames, mainFile, result, update, revision, completion };
}
