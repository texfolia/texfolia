import { type AnalyzeResponse, emptyAnalysis } from "@texfolia/editor";
import { LatexAnalyzer } from "@texfolia/editor";
import { emptyWordCount } from "@texfolia/editor";
import { useCallback, useEffect, useState } from "react";

import { createAnalysisWorker } from "#/lib/editor/latex/workers";

export function useLatexAnalysis(paths: string[], main?: string) {
  const [analyzer] = useState(() => new LatexAnalyzer(createAnalysisWorker));
  const [result, setResult] = useState<AnalyzeResponse>({
    revision: 0,
    analysis: emptyAnalysis,
    words: emptyWordCount,
  });
  useEffect(() => {
    analyzer.open(setResult);
    return () => analyzer.close();
  }, [analyzer]);
  useEffect(() => analyzer.setProject(paths, main), [analyzer, paths, main]);
  const update = useCallback(
    (path: string, text: string) => analyzer.update(path, text),
    [analyzer],
  );
  return { result, update, revision: analyzer.revision };
}
