import * as Y from "yjs";

import { decodeSource, encodeSource } from "#/lib/storage";

export type CommentAnchor = { anchorStart: string; anchorEnd: string };

// The start sticks to the first character of the range and the end to the
// last, so text typed just outside the range stays outside it.
export function createCommentAnchor(
  text: Y.Text,
  from: number,
  to: number,
): CommentAnchor {
  return {
    anchorStart: encodeSource(
      Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(text, from, 0),
      ),
    ),
    anchorEnd: encodeSource(
      Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(text, to, -1),
      ),
    ),
  };
}

// Returns null for bytes that are not a relative position into some type.
export function decodeCommentPosition(value: string) {
  try {
    const position = Y.decodeRelativePosition(decodeSource(value));
    return position.item || position.tname || position.type ? position : null;
  } catch {
    return null;
  }
}

// Returns null until the document has the items the anchor refers to, for
// example while an author's offline edits have not synchronized yet.
export function resolveCommentAnchor(text: Y.Text, anchor: CommentAnchor) {
  const doc = text.doc;
  if (!doc) return null;
  const resolve = (value: string) => {
    const position = decodeCommentPosition(value);
    if (!position) return null;
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      position,
      doc,
    );
    return absolute && absolute.type === text ? absolute.index : null;
  };
  const start = resolve(anchor.anchorStart);
  const end = resolve(anchor.anchorEnd);
  if (start === null || end === null) return null;
  return { from: Math.min(start, end), to: Math.max(start, end) };
}
