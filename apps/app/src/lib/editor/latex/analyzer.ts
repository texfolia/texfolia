import type { AnalyzeRequest, AnalyzeResponse } from "./analysis";

const updateDelayMs = 250;

/**
 * Keeps one analysis worker up to date with the project's files. Files can be
 * added, renamed and removed without restarting it; a worker that fails is
 * replaced on the next request.
 */
export class LatexAnalyzer {
  /** Counts text changes; an answer to an earlier one is dropped. */
  readonly revision = { current: 0 };
  private worker: Worker | undefined;
  private onResult: ((result: AnalyzeResponse) => void) | undefined;
  private contents = new Map<string, string>();
  // Paths whose text the worker does not have yet.
  private pending = new Set<string>();
  private paths: string[] = [];
  private known: ReadonlySet<string> = new Set();
  private main: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private createWorker: () => Worker) {}

  /** Starts answering; nothing is sent before `setProject`. */
  open(onResult: (result: AnalyzeResponse) => void) {
    this.onResult = onResult;
  }

  close() {
    this.onResult = undefined;
    clearTimeout(this.timer);
    this.stop();
  }

  setProject(paths: string[], main: string | undefined) {
    const previous = this.known;
    this.paths = paths;
    this.known = new Set(paths);
    this.main = main;
    // The worker forgot the text of any path that was missing until now.
    for (const path of paths)
      if (!previous.has(path) && this.contents.has(path))
        this.pending.add(path);
    this.flush();
  }

  update(path: string, text: string) {
    this.revision.current++;
    this.contents.set(path, text);
    this.pending.add(path);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), updateDelayMs);
  }

  private start() {
    const worker = this.createWorker();
    this.worker = worker;
    this.pending = new Set(this.contents.keys());
    worker.onmessage = ({ data }: MessageEvent<AnalyzeResponse>) => {
      if (this.worker === worker && data.revision === this.revision.current)
        this.onResult?.(data);
    };
    worker.onerror = worker.onmessageerror = () => {
      if (this.worker === worker) this.stop();
    };
    return worker;
  }

  private stop() {
    this.worker?.terminate();
    this.worker = undefined;
  }

  private flush() {
    if (!this.onResult) return;
    clearTimeout(this.timer);
    const worker = this.worker ?? this.start();
    const request: AnalyzeRequest = {
      revision: this.revision.current,
      paths: this.paths,
      main: this.main,
      updates: [...this.pending].flatMap((path) => {
        const text = this.contents.get(path);
        // A path that is not in the project yet is sent once it is.
        return this.known.has(path) && text !== undefined
          ? [[path, text] satisfies [string, string]]
          : [];
      }),
    };
    this.pending.clear();
    worker.postMessage(request);
  }
}
