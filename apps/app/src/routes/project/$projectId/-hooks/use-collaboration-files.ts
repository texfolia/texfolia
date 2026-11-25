import { useCallback, useEffect, useMemo, useState } from "react";

import { useStableCallback } from "#/hooks/use-stable-callback";
import {
  CollaborativeDocuments,
  type CollaborativeFile,
} from "#/lib/collaboration/browser";
import type { ProjectNode } from "#/lib/projects/project.functions";

type Options = ConstructorParameters<typeof CollaborativeDocuments>[0];

/**
 * Connects text files while they are open, or while their edits are unsaved.
 * Other files follow their saved sources; see `useSavedSources`.
 */
export function useCollaborationFiles({
  projectId,
  userId,
  canWrite,
  ready,
  nodes,
  deleted,
  recoverUnmarked,
  onSaved,
  onChange,
  onClose,
}: {
  projectId: string;
  userId: string;
  canWrite: boolean;
  ready: boolean;
  nodes: readonly Pick<ProjectNode, "id" | "kind">[];
  deleted: ReadonlySet<string>;
  recoverUnmarked?: Options["recoverUnmarked"];
  onSaved: Options["onSaved"];
  /** Called for every document change; `local` is true for this tab's edits. */
  onChange: Options["onChange"];
  onClose: Options["onClose"];
}) {
  const [revision, setRevision] = useState(0);
  const bump = () => setRevision((value) => value + 1);
  const saved = useStableCallback<Options["onSaved"]>((...args) => {
    onSaved(...args);
    bump();
  });
  const changed = useStableCallback(onChange);
  const closed = useStableCallback(onClose);
  // The route remounts per project, so the project and user never change.
  const [documents] = useState(
    () =>
      new CollaborativeDocuments({
        projectId,
        userId,
        recoverUnmarked,
        onSaved: saved,
        onChange: changed,
        onClose: closed,
        onDocuments: bump,
      }),
  );
  // A new map each revision lets context consumers notice new documents.
  const snapshot = useMemo<ReadonlyMap<string, CollaborativeFile>>(
    () => documents.snapshot(),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `documents` is mutable; a revision is a change to it.
    [documents, revision],
  );

  useEffect(() => {
    if (ready)
      documents.update({
        textIds: new Set(
          nodes.flatMap((node) => (node.kind === "text" ? [node.id] : [])),
        ),
        deleted,
        canWrite,
      });
  }, [documents, ready, nodes, deleted, canWrite]);

  useEffect(() => () => documents.destroy(), [documents]);

  return {
    snapshot,
    get: useCallback((id: string) => documents.get(id), [documents]),
    hold: useCallback((id: string) => documents.hold(id), [documents]),
    edit: useCallback<CollaborativeDocuments["edit"]>(
      (id, run, options) => documents.edit(id, run, options),
      [documents],
    ),
    synchronize: useCallback(() => documents.synchronize(), [documents]),
  };
}
