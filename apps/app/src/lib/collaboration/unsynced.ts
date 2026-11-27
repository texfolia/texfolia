import { unsyncedPrefix } from "./cache";

// Names the cached documents holding edits the server has not acknowledged, so
// a later session can merge them without opening every document's cache. Kept
// in localStorage because a marker must be written before the page can close.
type DocumentId = { userId: string; projectId: string; nodeId: string };

function projectPrefix({ userId, projectId }: Omit<DocumentId, "nodeId">) {
  return `${unsyncedPrefix(userId)}${projectId}.`;
}

/** Marks a document; each tab has its own marker, named by its Yjs client. */
export function markUnsynced(document: DocumentId, clientId: number) {
  const marker = `${projectPrefix(document)}${document.nodeId}.${clientId}`;
  try {
    localStorage.setItem(marker, "1");
  } catch {
    // The edit is still cached, and merges the next time its file is opened.
  }
  return marker;
}

/** The markers a document has now, from this tab and others. */
export function unsyncedMarkers(document: DocumentId) {
  const prefix = `${projectPrefix(document)}${document.nodeId}.`;
  return keys().filter((key) => key.startsWith(prefix));
}

export function removeMarkers(markers: Iterable<string>) {
  try {
    for (const marker of markers) localStorage.removeItem(marker);
  } catch {
    // A leftover marker only makes the next session check that document again.
  }
}

/** The project's documents that another session left with unsynced edits. */
export function unsyncedDocuments(project: Omit<DocumentId, "nodeId">) {
  const prefix = projectPrefix(project);
  return new Set(
    keys().flatMap((key) => {
      const nodeId = key.startsWith(prefix)
        ? key.slice(prefix.length).split(".")[0]
        : "";
      return nodeId ? [nodeId] : [];
    }),
  );
}

function keys() {
  try {
    return Object.keys(localStorage);
  } catch {
    return [];
  }
}
