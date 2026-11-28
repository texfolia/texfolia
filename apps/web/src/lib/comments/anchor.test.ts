import { describe, expect, test } from "bun:test";

import * as Y from "yjs";

import {
  createCommentAnchor,
  decodeCommentPosition,
  resolveCommentAnchor,
} from "./anchor";

function text(value: string) {
  const doc = new Y.Doc();
  const source = doc.getText("source");
  source.insert(0, value);
  return source;
}

function peer(source: Y.Text) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source.doc!));
  return doc.getText("source");
}

describe("comment anchors", () => {
  test("resolve to the original range", () => {
    const source = text("Hello brave new world");
    const anchor = createCommentAnchor(source, 6, 15);
    expect(resolveCommentAnchor(source, anchor)).toEqual({ from: 6, to: 15 });
  });

  test("follow edits before and inside the range", () => {
    const source = text("Hello brave new world");
    const anchor = createCommentAnchor(source, 6, 15);
    source.insert(0, ">> ");
    source.insert(14, "!");
    const range = resolveCommentAnchor(source, anchor);
    expect(range && source.toString().slice(range.from, range.to)).toBe(
      "brave! new",
    );
  });

  test("exclude text typed at either edge", () => {
    const source = text("Hello brave new world");
    const anchor = createCommentAnchor(source, 6, 11);
    source.insert(11, "st");
    source.insert(6, "very ");
    const range = resolveCommentAnchor(source, anchor);
    expect(range && source.toString().slice(range.from, range.to)).toBe(
      "brave",
    );
  });

  test("resolve in another replica", () => {
    const source = text("Hello brave new world");
    const anchor = createCommentAnchor(source, 6, 11);
    const other = peer(source);
    other.insert(0, "A ");
    const range = resolveCommentAnchor(other, anchor);
    expect(range && other.toString().slice(range.from, range.to)).toBe("brave");
  });

  test("collapse when the range is deleted", () => {
    const source = text("Hello brave new world");
    const anchor = createCommentAnchor(source, 6, 12);
    source.delete(6, 6);
    const range = resolveCommentAnchor(source, anchor);
    expect(range).not.toBeNull();
    expect(range?.from).toBe(range?.to);
  });

  test("stay unresolved until the referenced edits arrive", () => {
    const source = text("Hello");
    const other = peer(source);
    source.insert(5, " world");
    const anchor = createCommentAnchor(source, 6, 11);
    expect(resolveCommentAnchor(other, anchor)).toBeNull();
    Y.applyUpdate(other.doc!, Y.encodeStateAsUpdate(source.doc!));
    expect(resolveCommentAnchor(other, anchor)).toEqual({ from: 6, to: 11 });
  });

  test("reject malformed anchors", () => {
    const source = text("Hello");
    expect(decodeCommentPosition("BQ==")).toBeNull();
    expect(decodeCommentPosition("/////w==")).toBeNull();
    expect(
      resolveCommentAnchor(source, { anchorStart: "!!", anchorEnd: "AA==" }),
    ).toBeNull();
  });
});
