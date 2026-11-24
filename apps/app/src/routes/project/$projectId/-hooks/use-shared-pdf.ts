import { type BuildSnapshot } from "@texfolia/contracts";
import { useCallback, useEffect, useEffectEvent, useReducer } from "react";

import {
  type BuildRef,
  initialSharedPdf,
  pdfSaveState,
  sharedPdfFile,
  sharedPdfReducer,
  sharedPdfStep,
  shownPdfBuildId,
} from "#/lib/compile";
import { buildFileUrl } from "#/lib/compile/build";

/**
 * Follows the project's shared PDF, showing this tab's own builds until the
 * server has stored them. The transitions live in `#/lib/compile` (`shared-pdf`).
 */
export function useSharedPdf({
  projectId,
  build,
  compiling,
  onError,
}: {
  projectId: string;
  build: BuildSnapshot | null;
  compiling: boolean;
  onError: (message: string) => void;
}) {
  const [state, dispatch] = useReducer(sharedPdfReducer, initialSharedPdf);
  const file = sharedPdfFile(build);
  const sharedUrl = file ? buildFileUrl(projectId, file) : null;
  const step = sharedPdfStep(state, { build, sharedUrl, compiling });
  const stepUrl =
    step.kind === "keep" || step.kind === "clear" ? null : step.url;
  const reportError = useEffectEvent(onError);
  useEffect(() => {
    if (step.kind === "adopt") dispatch({ type: "adopted", url: step.url });
    if (step.kind === "clear") dispatch({ type: "cleared" });
    if (step.kind !== "load") return;
    const url = step.url;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok)
          throw new Error(
            "Could not load the shared PDF. Recompile to try again.",
          );
        const pdf = new File([await response.blob()], "output.pdf", {
          type: "application/pdf",
        });
        if (!controller.signal.aborted) dispatch({ type: "loaded", url, pdf });
      } catch (error) {
        if (!controller.signal.aborted)
          reportError(
            error instanceof Error
              ? error.message
              : "Could not load the shared PDF.",
          );
      }
    })();
    return () => controller.abort();
  }, [step.kind, stepUrl]);

  const showPreview = useCallback(
    (build: BuildRef, pdf: File) => dispatch({ type: "preview", build, pdf }),
    [],
  );
  const showCompiled = useCallback(
    (build: BuildRef, pdf: File) => dispatch({ type: "compiled", build, pdf }),
    [],
  );
  return {
    pdf: state.pdf,
    /** The build whose SyncTeX sidecar matches the PDF on screen. */
    pdfBuildId: shownPdfBuildId(state, build, sharedUrl),
    pdfSaveState: pdfSaveState(state, build),
    showPreview,
    showCompiled,
  };
}
