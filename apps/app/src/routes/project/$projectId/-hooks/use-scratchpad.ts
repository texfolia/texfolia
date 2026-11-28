import { useEffect, useRef } from "react";

import { scratchpadId } from "#/lib/collaboration";
import {
  type CollaborationConnection,
  documentCachingStopped,
} from "#/lib/collaboration/browser";
import { syncScratchpadMentions } from "#/lib/mentions/mentions.functions";
import { extractMentionedUserIds } from "#/lib/mentions/tokens";

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
  connection,
  onChange,
}: {
  projectId: string;
  userId: string;
  canWrite: boolean;
  ready: boolean;
  connection?: CollaborationConnection;
  onChange: (value: string) => void;
}) {
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastMentionKey = useRef<string | null>(null);
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;

  function syncMentions(value: string) {
    if (!canWriteRef.current) return;
    const ids = extractMentionedUserIds(value);
    const key = [...ids].sort().join(",");
    if (lastMentionKey.current === null && !ids.length) {
      lastMentionKey.current = "";
      return;
    }
    if (lastMentionKey.current === key) return;
    lastMentionKey.current = key;
    void syncScratchpadMentions({ data: { projectId, body: value } }).catch(
      () => {
        // Retry on next edit if offline or transient error.
        if (lastMentionKey.current === key) lastMentionKey.current = null;
      },
    );
  }

  const { snapshot, get, hold } = useCollaborationFiles({
    projectId,
    userId,
    canWrite,
    ready,
    nodes,
    deleted,
    connection,
    onSaved: ignore,
    onClose: ignore,
    onChange: (_id, value, local) => {
      onChange(value);
      if (local) scheduleSave();
      else if (lastMentionKey.current === null) {
        // Initialize from synced remote state without triggering notifications.
        lastMentionKey.current = [...extractMentionedUserIds(value)]
          .sort()
          .join(",");
      }
    },
  });

  // The room stores each edit as it arrives. A save asks it to confirm, so this
  // browser knows its edits are not only cached here.
  function scheduleSave() {
    if (saveTimer.current || !get(scratchpadId)?.hasPendingEdits()) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      const file = get(scratchpadId);
      if (file?.hasPendingEdits() && file.getStatus().connected) {
        const value = file.text.toString();
        syncMentions(value);
        // Edits that could not be confirmed stay pending until the next change.
        file.save().then(scheduleSave, ignore);
      }
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
