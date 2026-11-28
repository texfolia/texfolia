// Browser workers for LaTeX analysis and formatting. The `new URL` form lets
// the app's bundler emit each worker as its own asset; call only in a browser.

export function createAnalysisWorker() {
  return new Worker(new URL("./analysis.worker.ts", import.meta.url), {
    type: "module",
  });
}

export function createFormatWorker() {
  return new Worker(new URL("./format.worker.ts", import.meta.url), {
    type: "module",
  });
}
