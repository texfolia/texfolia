import { useEffect, useState } from "react";

import { buildFileUrl, type BuildSnapshot } from "#/lib/build";
import {
  parseSyncTex,
  readSyncTex,
  syncTexArtifact,
  type SyncTexIndex,
} from "#/lib/latex/synctex";

export function useSyncTex({
  projectId,
  build,
  pdfBuildId,
  paths,
  stale,
}: {
  projectId: string;
  build: BuildSnapshot | null;
  pdfBuildId: string | null;
  paths: ReadonlyMap<string, string>;
  stale: boolean;
}) {
  const artifact = syncTexArtifact({ build, pdfBuildId });
  const url = artifact ? buildFileUrl(projectId, artifact) : null;
  const [loaded, setLoaded] = useState<{
    url: string;
    paths: ReadonlyMap<string, string>;
    index: SyncTexIndex;
  } | null>(null);
  useEffect(() => {
    if (!url || stale) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return;
        const text = await readSyncTex(await response.blob());
        if (controller.signal.aborted) return;
        const index = parseSyncTex(text, paths.values());
        setLoaded({ url, paths, index });
      } catch {
        // SyncTeX is optional; a missing or damaged sidecar leaves the PDF usable.
      }
    })();
    return () => controller.abort();
  }, [url, paths, stale]);
  return !stale && loaded?.url === url && loaded.paths === paths
    ? loaded.index
    : null;
}
