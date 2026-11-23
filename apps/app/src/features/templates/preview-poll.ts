type PreviewStatus = {
  id: string;
  previewStatus: "queued" | "ready" | "failed";
};

// At most four queued previews advance at a time.
export function queuedTemplatePreviews(templates: readonly PreviewStatus[]) {
  return templates
    .filter((item) => item.previewStatus === "queued")
    .slice(0, 4)
    .map((item) => item.id);
}

// Advances queued previews one at a time, then calls `refreshed`, and repeats
// until stopped. Returns the stop function.
export function pollTemplatePreviews({
  templateIds,
  refresh,
  refreshed,
  intervalMs = 3000,
}: {
  templateIds: readonly string[];
  refresh: (templateId: string) => Promise<unknown>;
  refreshed: () => Promise<unknown>;
  intervalMs?: number;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function advance() {
    try {
      for (const templateId of templateIds) {
        if (stopped) return;
        await refresh(templateId);
      }
      if (!stopped) await refreshed();
    } catch {
      // A temporary service failure can be retried without losing the snapshot.
    } finally {
      if (!stopped) timer = setTimeout(advance, intervalMs);
    }
  }
  void advance();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
