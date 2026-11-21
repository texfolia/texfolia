import { IconDownload } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import CodeMirror from "@uiw/react-codemirror";
import type { IDockviewPanelProps } from "dockview-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { buildFileUrl } from "#/lib/build";
import { downloadFile } from "#/lib/download-file";
import { useTheme } from "#/providers/theme-provider";
import { useWorkspace } from "#/providers/workspace-provider";

const PdfViewer = lazy(() => import("./pdf"));
export function GeneratedFile({
  params,
}: IDockviewPanelProps<{ path: string }>) {
  const {
    build,
    projectId,
    stale,
    pdf: compiledPdf,
    synctex,
    pdfJump,
    reveal,
  } = useWorkspace();
  const { theme } = useTheme();
  const file = build?.artifacts?.files.find(
    (file) => file.path === params.path,
  );
  const url = file ? buildFileUrl(projectId, file) : null;
  const [loaded, setLoaded] = useState<{
    url: string;
    blob: Blob;
    text: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setError("");
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok)
          throw new Error(
            "Could not load the build file. Reopen it to try again.",
          );
        const blob = await response.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let text: string | null = null;
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
          if (!decoded.includes("\0")) text = decoded;
        } catch {
          /* Binary files remain available for download. */
        }
        if (!controller.signal.aborted) setLoaded({ url, blob, text });
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load the build file.",
          );
      }
    })();
    return () => controller.abort();
  }, [url]);
  const pdf = useMemo(
    () =>
      loaded?.url === url
        ? new File([loaded.blob], params.path, { type: "application/pdf" })
        : null,
    [loaded, params.path, url],
  );
  if (!file)
    return (
      <p role="status" className="p-4 text-sm">
        This file is no longer in the latest build.
      </p>
    );
  const content = loaded?.url === url ? loaded : null;
  if (/\.pdf$/i.test(file.path)) {
    const output =
      build?.artifacts?.pdf === file.path ? (compiledPdf ?? pdf) : pdf;
    if (!output)
      return (
        <p role={error ? "alert" : "status"} className="p-3 text-sm">
          {error || "Loading PDF…"}
        </p>
      );
    return (
      <div className="flex h-full min-h-0 flex-col">
        {stale && (
          <p
            role="status"
            className="text-muted-foreground border-b px-2 py-1 text-xs"
          >
            Out of date, recompile
          </p>
        )}
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={<p className="p-3 text-sm">Loading PDF viewer…</p>}
          >
            <PdfViewer
              file={output}
              filename={file.path}
              sync={
                output === compiledPdf && synctex
                  ? {
                      index: synctex,
                      reveal,
                      target:
                        pdfJump?.index === synctex ? pdfJump.location : null,
                    }
                  : undefined
              }
            />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate">out/{file.path}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!content}
          onClick={() =>
            content && downloadFile(content.blob, file.path.split("/").at(-1)!)
          }
        >
          <IconDownload />
          Download
        </Button>
      </div>
      {stale && (
        <p
          role="status"
          className="text-muted-foreground border-b px-3 py-2 text-xs"
        >
          Out of date, recompile
        </p>
      )}
      {error ? (
        <p role="alert" className="text-destructive p-4 text-sm">
          {error}
        </p>
      ) : !content ? (
        <p role="status" className="p-4 text-sm">
          Loading build file…
        </p>
      ) : content.text !== null ? (
        <CodeMirror
          value={content.text}
          readOnly
          editable={false}
          theme={theme.extension}
          height="100%"
          aria-label={`Generated file out/${file.path} (read-only)`}
          className="min-h-0 flex-1 overflow-auto"
        />
      ) : (
        <p className="text-muted-foreground p-4 text-sm">
          Binary file · {file.sizeBytes.toLocaleString()} bytes. Download to
          view.
        </p>
      )}
    </section>
  );
}
