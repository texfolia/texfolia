import {
  analyzeProject,
  type AnalyzeRequest,
  type AnalyzeResponse,
  countWords,
  scanFile,
  type WordEvent,
  wordEvents,
} from "@texfolia/editor";

const files = new Map<string, ReturnType<typeof scanFile>>();
const words = new Map<string, WordEvent[]>();
let latest: AnalyzeRequest | undefined;
let packages: Record<string, string[]> = {};

function publish({ paths, revision, main }: AnalyzeRequest) {
  const response: AnalyzeResponse = {
    revision,
    analysis: analyzeProject(files, paths, packages),
    words: countWords(words, main),
  };
  self.postMessage(response);
}

void fetch(`${import.meta.env.BASE_URL}latex-packages.json`)
  .then(async (response): Promise<Record<string, string[]>> =>
    response.ok ? response.json() : {},
  )
  .then((catalog) => {
    packages = catalog;
    if (latest) publish(latest);
  })
  .catch(() => {});

self.onmessage = ({ data }: MessageEvent<AnalyzeRequest>) => {
  // The worker outlives its files, so it forgets the ones that are gone.
  const paths = new Set(data.paths);
  for (const path of files.keys())
    if (!paths.has(path)) {
      files.delete(path);
      words.delete(path);
    }
  for (const [path, text] of data.updates) {
    files.set(path, scanFile(path, text));
    if (/\.(?:tex|ltx)$/i.test(path)) words.set(path, wordEvents(text));
  }
  latest = data;
  publish(data);
};
