import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  queuedTemplatePreviews,
  subscribeTemplatePreviews,
} from "#/features/templates";

export function useTemplatePreviews(
  templates: Parameters<typeof queuedTemplatePreviews>[0],
) {
  const router = useRouter();
  const queued = queuedTemplatePreviews(templates).join(",");
  useEffect(() => {
    if (!queued) return;
    return subscribeTemplatePreviews({
      templateIds: queued.split(","),
      onSettled: () => void router.invalidate(),
    });
  }, [queued, router]);
}
