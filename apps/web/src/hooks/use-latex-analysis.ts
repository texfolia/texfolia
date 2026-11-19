import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AnalyzeRequest,
  type AnalyzeResponse,
  emptyAnalysis,
} from "#/lib/latex/analysis";
import { emptyWordCount } from "#/lib/latex/word-count";

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
    const instance = new Worker(
      new URL("../lib/latex/analysis.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
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
