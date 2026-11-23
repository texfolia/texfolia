import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";

import {
  CollaborativeDocuments,
  type CollaborativeFile,
} from "#/features/collaboration/browser";
import type { ProjectNode } from "#/features/projects/project.functions";

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
  onSaved,
  onChange,
  onClose,
}: {
  projectId: string;
  userId: string;
  canWrite: boolean;
  ready: boolean;
  nodes: ProjectNode[];
  deleted: ReadonlySet<string>;
  onSaved: Options["onSaved"];
  /** Called for every document change; `local` is true for this tab's edits. */
  onChange: Options["onChange"];
  onClose: Options["onClose"];
}) {
  const [revision, setRevision] = useState(0);
  const bump = () => setRevision((value) => value + 1);
  const saved = useEffectEvent<Options["onSaved"]>((...args) => {
    onSaved(...args);
    bump();
  });
  const changed = useEffectEvent(onChange);
  const closed = useEffectEvent(onClose);
  // The route remounts per project, so the project and user never change.
  const [documents] = useState(
    () =>
      new CollaborativeDocuments({
        projectId,
        userId,
        onSaved: (...args) => saved(...args),
        onChange: (...args) => changed(...args),
        onClose: (...args) => closed(...args),
        onDocuments: bump,
      }),
  );
  // A new map each revision lets context consumers notice new documents.
  const snapshot = useMemo<ReadonlyMap<string, CollaborativeFile>>(
    () => documents.snapshot(),
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
      (id, run) => documents.edit(id, run),
      [documents],
    ),
    synchronize: useCallback(() => documents.synchronize(), [documents]),
  };
}
