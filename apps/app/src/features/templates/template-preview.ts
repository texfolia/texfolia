import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  pollTemplatePreviews,
  queuedTemplatePreviews,
} from "#/features/templates";

import { refreshTemplatePreview } from "./template.functions";

export function useTemplatePreviews(
  templates: Parameters<typeof queuedTemplatePreviews>[0],
) {
  const router = useRouter();
  const queued = queuedTemplatePreviews(templates).join(",");
  useEffect(() => {
    if (!queued) return;
    return pollTemplatePreviews({
      templateIds: queued.split(","),
      refresh: (templateId) =>
        refreshTemplatePreview({ data: { templateId, retry: false } }),
      refreshed: () => router.invalidate(),
    });
  }, [queued, router]);
}
