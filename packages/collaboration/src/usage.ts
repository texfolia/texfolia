import { maxSourceFileBytes } from "@texfolia/storage";
import * as Y from "yjs";

import { maxCollaborationBytes } from "./protocol";

export type Usage = { textBytes: number; historyBytes: number };

const encoder = new TextEncoder();
// One split of an existing item encodes as one more item header, well under this.
const splitBytes = 64;

function limitError() {
  return new Error("Collaborative document exceeds its text or history limit");
}

function withinLimits(usage: Usage) {
  return (
    usage.textBytes <= maxSourceFileBytes &&
    usage.historyBytes <= maxCollaborationBytes
  );
}

export function measureUsage(doc: Y.Doc): Usage {
  return {
    textBytes: encoder.encode(doc.getText("source").toString()).byteLength,
    historyBytes: Y.encodeStateAsUpdate(doc).byteLength,
  };
}

// Bounds usage after `update` from its own structs, without touching the
// document's content. Deletions only shrink text, and each new struct or
// deleted range splits at most two existing items.
function estimateUsage(doc: Y.Doc, usage: Usage, update: Uint8Array): Usage {
  const { structs, ds } = Y.decodeUpdate(update);
  let textBytes = usage.textBytes;
  let splits = 0;
  for (const struct of structs) {
    const known = Y.getState(doc.store, struct.id.client) - struct.id.clock;
    // Yjs skips structs the document already has.
    if (known >= struct.length || !(struct instanceof Y.Item)) continue;
    // Decoded items name a root by key, or omit the parent to inherit it from
    // their origins, which are already in `source` or validated with them.
    const parent: unknown = struct.parent;
    if (struct.parentSub !== null || (parent !== null && parent !== "source"))
      throw limitError();
    if (struct.content instanceof Y.ContentString)
      textBytes += encoder.encode(
        struct.content.str.slice(Math.max(known, 0)),
      ).byteLength;
    else if (!(struct.content instanceof Y.ContentDeleted)) throw limitError();
    splits += 2;
  }
  for (const ranges of ds.clients.values()) splits += 2 * ranges.length;
  return {
    textBytes,
    historyBytes: usage.historyBytes + update.byteLength + splits * splitBytes,
  };
}

// Measures exactly on a disposable copy, for estimates near a limit.
function exactUsage(doc: Y.Doc, update: Uint8Array) {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(candidate, update);
    return measureUsage(candidate);
  } finally {
    candidate.destroy();
  }
}

// Returns usage after applying `update`, or throws if the update is not plain
// text in `source` or would exceed a limit. The document is left unchanged.
export function checkUpdate(doc: Y.Doc, usage: Usage, update: Uint8Array) {
  const estimate = estimateUsage(doc, usage, update);
  if (withinLimits(estimate)) return estimate;
  const exact = exactUsage(doc, update);
  if (!withinLimits(exact)) throw limitError();
  return exact;
}
