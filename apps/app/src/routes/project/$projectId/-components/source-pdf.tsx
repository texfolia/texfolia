import { lazy, Suspense, useEffect, useState } from "react";

import type { ProjectNode } from "#/lib/projects/project.functions";
import { useWorkspaceActions } from "#/providers/workspace-provider";

const PdfViewer = lazy(() => import("./pdf"));

export function SourcePdf({ node }: { node: ProjectNode }) {
  const { projectId } = useWorkspaceActions();
  const [file, setFile] = useState<File>();
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/sources/${projectId}/${node.id}`, {
          signal: abort.signal,
        });
        if (!response.ok)
          throw new Error(
            "Could not open this PDF. Reopen the tab to try again.",
          );
        const blob = await response.blob();
        if (!abort.signal.aborted)
          setFile(new File([blob], node.name, { type: "application/pdf" }));
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not open this PDF.",
          );
      }
    })();
    return () => abort.abort();
  }, [projectId, node.id, node.name]);
  if (error)
    return (
      <p role="alert" className="text-destructive p-3 text-sm">
        {error}
      </p>
    );
  if (!file)
    return (
      <p role="status" className="p-3 text-sm">
        Loading PDF…
      </p>
    );
  return (
    <Suspense fallback={<p className="p-3 text-sm">Loading PDF viewer…</p>}>
      <PdfViewer file={file} filename={node.name} />
    </Suspense>
  );
}
