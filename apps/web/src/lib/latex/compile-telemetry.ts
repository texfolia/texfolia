import { z } from "zod";

const duration = z.number().finite().nonnegative();
export const previewTimingSchema = z.object({
  outcome: z.enum(["rendered", "preview_failed"]),
  submissionMs: duration,
  pollingMs: duration,
  downloadMs: duration,
  previewMs: duration,
  actionToPdfMs: duration,
  keystrokeToPdfMs: duration.nullable(),
});
export type PreviewTiming = z.infer<typeof previewTimingSchema>;

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
    };
    void fetch(options.statusUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => undefined);
  });
}

export function reportCompilePreview(
  file: string | File | null,
  outcome: PreviewTiming["outcome"],
) {
  if (file instanceof File) previews.get(file)?.(outcome);
}
