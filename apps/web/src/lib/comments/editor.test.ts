import { describe, expect, test } from "bun:test";

import { EditorState } from "@uiw/react-codemirror";

import { commentRanges, commentRangesOf, setCommentRanges } from "./editor";

function editor(doc: string) {
  return EditorState.create({ doc, extensions: commentRanges(() => {}) });
}

describe("editor comment ranges", () => {
  test("replace ranges and clamp them to the document", () => {
    const state = editor("Hello world").update({
      effects: setCommentRanges.of({
        ranges: [
          { id: "a", from: 6, to: 11 },
          { id: "b", from: 4, to: 40 },
        ],
        activeId: "a",
      }),
    }).state;
    expect(commentRangesOf(state)).toEqual([
      { id: "a", from: 6, to: 11 },
      { id: "b", from: 4, to: 11 },
    ]);
  });

  test("follow edits without growing at the edges", () => {
    let state = editor("Hello world").update({
      effects: setCommentRanges.of({
        ranges: [{ id: "a", from: 6, to: 11 }],
        activeId: undefined,
      }),
    }).state;
    state = state.update({
      changes: [
        { from: 0, insert: ">> " },
        { from: 6, insert: "big " },
        { from: 11, insert: "!" },
      ],
    }).state;
    const [range] = commentRangesOf(state);
    expect(range && state.sliceDoc(range.from, range.to)).toBe("world");
  });

  test("collapse when the text is deleted", () => {
    let state = editor("Hello world").update({
      effects: setCommentRanges.of({
        ranges: [{ id: "a", from: 6, to: 11 }],
        activeId: undefined,
      }),
    }).state;
    state = state.update({ changes: { from: 5, to: 11 } }).state;
    expect(commentRangesOf(state)).toEqual([{ id: "a", from: 5, to: 5 }]);
  });
});
