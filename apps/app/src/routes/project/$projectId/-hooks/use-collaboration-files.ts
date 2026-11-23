import { CollaborativeFile } from "@texfolia/collaboration/browser";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import type { ProjectNode } from "#/lib/project.functions";

type Saved = Parameters<
  NonNullable<ConstructorParameters<typeof CollaborativeFile>[0]["onSaved"]>
>[0];

/**
 * Keeps one collaborative document per text file. Documents are created
 * lazily, retired (not destroyed) when their file is deleted so open tabs keep
 * their text, and destroyed when the workspace unmounts.
 */
export function useCollaborationFiles({
  projectId,
  userId,
  canWrite,
  ready,
  nodes,
  deleted,
  currentDeleted,
  onSaved,
  onChange,
}: {
  projectId: string;
  userId: string;
  canWrite: boolean;
  ready: boolean;
  nodes: ProjectNode[];
  deleted: ReadonlySet<string>;
  /** The deleted set as it is now, for reconciles run after an await. */
  currentDeleted: () => ReadonlySet<string>;
  onSaved: (id: string, saved: Saved, file: CollaborativeFile) => void;
  /** Called for every document change; `local` is true for this tab's edits. */
  onChange: (id: string, value: string, local: boolean | undefined) => void;
}) {
  const documents = useRef(new Map<string, CollaborativeFile>());
  const [revision, setRevision] = useState(0);
  // A new map each revision lets context consumers notice new documents.
  const snapshot = useMemo<ReadonlyMap<string, CollaborativeFile>>(
    () => new Map(documents.current),
    [revision],
  );
  const saved = useEffectEvent(onSaved);
  const changed = useEffectEvent(onChange);
  const bump = () => setRevision((value) => value + 1);

  function reconcile(nodes: ProjectNode[]) {
    let created = false;
    for (const node of nodes) {
      if (node.kind !== "text") continue;
      const existing = documents.current.get(node.id);
      if (existing) {
        existing.refreshAccess(canWrite);
        continue;
      }
      const id = node.id;
      let initialized = false;
      const file: CollaborativeFile = new CollaborativeFile({
        projectId,
        nodeId: id,
        userId,
        canWrite,
        onSaved: (value) => {
          saved(id, value, file);
          bump();
        },
        onChange: (value, local) => {
          changed(id, value, local);
          if (!initialized) {
            initialized = true;
            bump();
          }
        },
      });
      documents.current.set(id, file);
      created = true;
    }
    for (const [id, file] of documents.current) {
      if (!currentDeleted().has(id)) continue;
      // Keep deleted documents and their panels available for copying/recovery.
      // Retiring stops reconnects without discarding the IndexedDB document.
      file.retire();
    }
    if (created) bump();
  }

  const reconcileCurrent = useEffectEvent(() => reconcile(nodes));
  useEffect(() => {
    if (ready) reconcileCurrent();
  }, [ready, nodes, projectId, canWrite, userId, deleted]);

  useEffect(
    () => () => {
      for (const file of documents.current.values()) file.destroy();
      documents.current.clear();
    },
    [],
  );

  return {
    snapshot,
    get: (id: string) => documents.current.get(id),
    /** Creates any missing documents and waits until each one is connected. */
    async synchronize(nodes: ProjectNode[]) {
      reconcile(nodes);
      await Promise.all(
        nodes
          .filter((node) => node.kind === "text")
          .map(async (node) => {
            const file = documents.current.get(node.id);
            if (!file) throw new Error("Could not synchronize project files");
            await file.whenConnected();
          }),
      );
    },
  };
}
