import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { refreshTemplatePreview } from "./template.functions";

export function useTemplatePreviews(
  templates: { id: string; previewStatus: "queued" | "ready" | "failed" }[],
) {
  const router = useRouter();
  const queued = templates
    .filter((item) => item.previewStatus === "queued")
    .slice(0, 4)
    .map((item) => item.id)
    .join(",");
  useEffect(() => {
    if (!queued) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function advance() {
      try {
        for (const templateId of queued.split(",")) {
          if (stopped) return;
          await refreshTemplatePreview({ data: { templateId, retry: false } });
        }
        if (!stopped) await router.invalidate();
      } catch {
        // A temporary service failure can be retried without losing the snapshot.
      } finally {
        if (!stopped) timer = setTimeout(advance, 3000);
      }
    }
    void advance();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [queued, router]);
}
