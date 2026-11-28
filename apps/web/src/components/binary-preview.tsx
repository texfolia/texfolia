import { lazy, type ReactNode, Suspense } from "react";

import { ImagePreview } from "#/components/image-preview";
import { useSourceFile } from "#/hooks/use-source-file";
import { previewType } from "#/lib/storage/preview";

const PdfViewer = lazy(
  () => import("#/routes/project/$projectId/-components/pdf"),
);

/** Shows an image or PDF source file, or `fallback` for any other file. */
export function BinaryPreview({
  url,
  name,
  version,
  fallback,
}: {
  url: string;
  name: string;
  /** Changes when the file does. */
  version?: string;
  fallback: ReactNode;
}) {
  const type = previewType(name);
  const { file, error } = useSourceFile({ url, name, type, version });
  if (!type) return fallback;
  if (error)
    return (
      <p role="alert" className="text-destructive p-3 text-sm">
        {error}
      </p>
    );
  if (!file)
    return (
      <p role="status" className="p-3 text-sm">
        Loading file…
      </p>
    );
  if (type.startsWith("image/")) return <ImagePreview file={file} />;
  return (
    <Suspense fallback={<p className="p-3 text-sm">Loading PDF viewer…</p>}>
      <PdfViewer file={file} filename={name} />
    </Suspense>
  );
}
