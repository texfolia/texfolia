import { z } from "zod";

export const templatePreviewEventSchema = z.object({
  previewStatus: z.enum(["ready", "failed"]),
});

type PreviewStatus = {
  id: string;
  previewStatus: "queued" | "ready" | "failed";
};

export type PreviewEventSource = {
  onmessage: ((event: MessageEvent) => unknown) | null;
  close(): void;
};

// At most four queued previews subscribe at a time.
export function queuedTemplatePreviews(templates: readonly PreviewStatus[]) {
  return templates
    .filter((item) => item.previewStatus === "queued")
    .slice(0, 4)
    .map((item) => item.id);
}

// Subscribes to preview readiness events for each queued template and calls
// `onSettled` when a preview becomes ready or fails. Returns the stop function.
export function subscribeTemplatePreviews({
  templateIds,
  onSettled,
  createSource = (url) => new EventSource(url),
}: {
  templateIds: readonly string[];
  onSettled: (templateId: string, status: "ready" | "failed") => void;
  createSource?: (url: string) => PreviewEventSource;
}) {
  let stopped = false;
  const sources = new Map<string, PreviewEventSource>();
  for (const templateId of templateIds) {
    const source = createSource(
      `/api/templates/${encodeURIComponent(templateId)}/preview?events=1`,
    );
    sources.set(templateId, source);
    source.onmessage = (event) => {
      if (stopped) return;
      let parsed: ReturnType<typeof templatePreviewEventSchema.safeParse>;
      try {
        parsed = templatePreviewEventSchema.safeParse(JSON.parse(event.data));
      } catch {
        return;
      }
      if (!parsed.success) return;
      source.close();
      sources.delete(templateId);
      onSettled(templateId, parsed.data.previewStatus);
    };
  }
  return () => {
    stopped = true;
    for (const source of sources.values()) source.close();
    sources.clear();
  };
}
