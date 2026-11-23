import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { CollaborativeFile } from "#/features/collaboration/browser";
import type { ProjectDetails } from "#/features/projects/project.functions";
import { binaryFetchLimit, mapLimit } from "#/lib/map-limit";
import type { useProjectFiles } from "#/providers/project-files-provider";
import type { FileState } from "#/providers/workspace-provider";

/**
 * Keeps the text of files without a live document at their saved version, so
 * search, analysis and export cover every file. The room saves collaborators'
 * edits within seconds, and the metadata poll then reports the new version.
 */
export function useSavedSources({
  project,
  ready,
  files,
  collaboration,
  drafts,
  onLoaded,
}: {
  project: Pick<ProjectDetails, "id" | "sourceVersions">;
  ready: boolean;
  files: ReturnType<typeof useProjectFiles>;
  collaboration: {
    get: (id: string) => CollaborativeFile | undefined;
    snapshot: ReadonlyMap<string, CollaborativeFile>;
  };
  drafts: Map<string, FileState>;
  onLoaded: (id: string, value: string) => void;
}) {
  const projectId = project.id;
  // The object each draft's text came from.
  const loaded = useRef(
    new Map(
      Object.entries(project.sourceVersions).map(([id, version]) => [
        id,
        version.objectKey,
      ]),
    ),
  );
  const queue = useRef(Promise.resolve());
  const [, setRevision] = useState(0);

  async function load() {
    const changed = files.nodes.toArray.flatMap(({ id, kind }) => {
      const version = files.sourceVersions[id];
      return kind === "text" &&
        version &&
        !collaboration.get(id) &&
        version.objectKey !== loaded.current.get(id)
        ? [{ id, objectKey: version.objectKey }]
        : [];
    });
    await mapLimit(changed, binaryFetchLimit, async ({ id, objectKey }) => {
      let value = "";
      if (objectKey) {
        const response = await fetch(`/api/sources/${projectId}/${id}`);
        if (!response.ok)
          throw new Error(
            `Could not load ${files.nodes.get(id)?.name ?? "a project file"}`,
          );
        value = await response.text();
      }
      // The file may have been opened meanwhile; its document is newer.
      if (collaboration.get(id)) return;
      loaded.current.set(id, objectKey);
      const previous = drafts.get(id);
      drafts.set(id, { value, savedValue: value });
      if (previous?.value === value) return;
      onLoaded(id, value);
      setRevision((revision) => revision + 1);
    });
  }

  /** Loads every changed source, after any load already running. */
  function refresh() {
    const next = queue.current.then(load);
    queue.current = next.catch(() => {});
    return next;
  }

  const refreshed = useEffectEvent(() => {
    // The next metadata refresh retries sources that failed to load.
    if (ready) void refresh().catch(() => {});
  });
  useEffect(() => files.onRefresh(() => refreshed()), [files]);
  useEffect(() => refreshed(), [ready, collaboration.snapshot]);

  return {
    refresh,
    /** Keeps a closing document's text until its saved version is newer. */
    keep(id: string, file: CollaborativeFile) {
      if (!file.getStatus().ready) return;
      const value = file.text.toString();
      const objectKey = file.savedAs();
      if (objectKey === undefined) loaded.current.delete(id);
      else loaded.current.set(id, objectKey);
      drafts.set(id, { value, savedValue: value });
    },
  };
}
