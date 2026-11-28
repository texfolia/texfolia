import type { PreviewTiming } from "@texfolia/contracts";

// The File identity keeps renders of older PDFs attached to their own job.
const previews = new WeakMap<
  File,
  (outcome: PreviewTiming["outcome"]) => void
>();

export function trackCompilePreview(options: {
  file: File;
  statusUrl: string;
  startedAt: number;
  lastEditAt: number | null;
  submissionMs: number;
  pollingMs: number;
  downloadMs: number;
  firstPdfByteMs?: number;
  requestSentMs?: number;
  serverMs?: number;
  notifiedAt?: () => number | undefined;
  completion?: Promise<unknown>;
}) {
  const readyAt = performance.now();
  previews.set(options.file, (outcome) => {
    previews.delete(options.file);
    const now = performance.now();
    const report: PreviewTiming = {
      outcome,
      submissionMs: options.submissionMs,
      pollingMs: options.pollingMs,
      downloadMs: options.downloadMs,
      previewMs: now - readyAt,
      actionToPdfMs: now - options.startedAt,
      keystrokeToPdfMs:
        options.lastEditAt === null ? null : now - options.lastEditAt,
      firstPdfByteMs: options.firstPdfByteMs,
      requestSentMs: options.requestSentMs,
      serverMs: options.serverMs,
    };
    void (options.completion ?? Promise.resolve())
      .then(() => {
        // A streamed preview can render before the completion event arrives.
        const notifiedAt = options.notifiedAt?.();
        if (notifiedAt !== undefined)
          report.notifiedMs = Math.max(0, notifiedAt - options.startedAt);
        return fetch(options.statusUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report),
          keepalive: true,
        });
      })
      .catch(() => undefined);
  });
}

export function reportCompilePreview(
  file: string | File | null,
  outcome: PreviewTiming["outcome"],
) {
  if (file instanceof File) previews.get(file)?.(outcome);
}
