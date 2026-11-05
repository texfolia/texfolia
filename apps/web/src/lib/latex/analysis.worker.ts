import {
  analyzeProject,
  type AnalyzeRequest,
  type AnalyzeResponse,
  scanFile,
} from "./analysis";

const files = new Map<string, ReturnType<typeof scanFile>>();
let latest: AnalyzeRequest | undefined;
let packages: Record<string, string[]> = {};

function publish({ paths, revision }: AnalyzeRequest) {
  const response: AnalyzeResponse = {
    revision,
    analysis: analyzeProject(files, paths, packages),
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
  for (const [path, text] of data.updates)
    files.set(path, scanFile(path, text));
  latest = data;
  publish(data);
};
