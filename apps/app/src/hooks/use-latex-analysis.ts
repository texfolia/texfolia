import {
  type AnalyzeRequest,
  type AnalyzeResponse,
  emptyAnalysis,
} from "@texfolia/editor/latex/analysis";
import { emptyWordCount } from "@texfolia/editor/latex/word-count";
import { createAnalysisWorker } from "@texfolia/editor/latex/workers";
import { useCallback, useEffect, useRef, useState } from "react";

export function useLatexAnalysis(paths: string[], main?: string) {
  const worker = useRef<Worker | null>(null);
  const contents = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [result, setResult] = useState<AnalyzeResponse>({
    revision: 0,
    analysis: emptyAnalysis,
    words: emptyWordCount,
  });

  const flush = useCallback(() => {
    if (!worker.current) return;
    const request: AnalyzeRequest = {
      revision: revision.current,
      paths,
      main,
      updates: [...pending.current].map((path) => [
        path,
        contents.current.get(path) ?? "",
      ]),
    };
    worker.current.postMessage(request);
    pending.current.clear();
  }, [paths, main]);

  useEffect(() => {
    const instance = createAnalysisWorker();
    worker.current = instance;
    pending.current = new Set(
      paths.filter((path) => contents.current.has(path)),
    );
    instance.onmessage = ({ data }: MessageEvent<AnalyzeResponse>) => {
      if (data.revision === revision.current) setResult(data);
    };
    flush();
    return () => {
      clearTimeout(timer.current);
      worker.current = null;
      instance.terminate();
    };
  }, [flush, paths]);

  const update = useCallback(
    (path: string, text: string) => {
      revision.current++;
      contents.current.set(path, text);
      pending.current.add(path);
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 250);
    },
    [flush],
  );

  return { result, update, revision };
}
