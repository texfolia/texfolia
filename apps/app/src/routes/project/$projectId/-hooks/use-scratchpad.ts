import { useEffect, useRef } from "react";

import { scratchpadId } from "#/lib/collaboration";
import { documentCachingStopped } from "#/lib/collaboration/browser";

import { useCollaborationFiles } from "./use-collaboration-files";

const nodes = [{ id: scratchpadId, kind: "text" }] as const;
const deleted: ReadonlySet<string> = new Set();
const saveDelayMs = 1000;
const ignore = () => {};

/**
 * Connects the project's scratchpad while its tab or preview is open. It has its
 * own document set, so saving, compiling, exporting, Git and search, which cover
 * the project's documents, never wait on it or include it.
 */
export function useScratchpad({
  projectId,
  userId,
  canWrite,
  ready,
  onChange,
}: {
  projectId: string;
  userId: string;
  canWrite: boolean;
  ready: boolean;
  onChange: (value: string) => void;
}) {
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { snapshot, get, hold } = useCollaborationFiles({
    projectId,
    userId,
    canWrite,
    ready,
    nodes,
    deleted,
    recoverUnmarked: false,
    onSaved: ignore,
    onClose: ignore,
    onChange: (_id, value) => {
      onChange(value);
      scheduleSave();
    },
  });

  // The room stores each edit as it arrives. A save asks it to confirm, so this
  // browser knows its edits are not only cached here.
  function scheduleSave() {
    if (saveTimer.current || !get(scratchpadId)?.hasPendingEdits()) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      const file = get(scratchpadId);
      if (file?.hasPendingEdits() && file.getStatus().connected)
        // Edits that could not be confirmed stay pending until the next change.
        file.save().then(scheduleSave, ignore);
    }, saveDelayMs);
  }
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    },
    [],
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!documentCachingStopped() && get(scratchpadId)?.hasPendingEdits())
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [get]);

  return { file: snapshot.get(scratchpadId), hold };
}
