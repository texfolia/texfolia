import { expect, test } from "bun:test";

import { ensureSyntaxTree, foldable } from "@codemirror/language";
import { EditorState } from "@uiw/react-codemirror";

import { markdownSupport } from "./markdown";

function open(doc: string) {
  const state = EditorState.create({ doc, extensions: markdownSupport() });
  ensureSyntaxTree(state, doc.length, 500);
  return state;
}

test("headings fold their section", () => {
  const doc = "# One\n\ntext\n\n## Two\n\nmore\n\n# Three\n\nend";
  const state = open(doc);
  const fold = (line: number) => {
    const { from, to } = state.doc.line(line);
    const range = foldable(state, from, to);
    return range && state.sliceDoc(range.from, range.to).trimEnd();
  };
  expect(fold(1)).toBe("\n\ntext\n\n## Two\n\nmore");
  expect(fold(5)).toBe("\n\nmore");
  expect(fold(3)).toBeNull();
});

test("raw HTML blocks parse as Markdown nodes", () => {
  const state = open("<div>\n<b>x</b>\n</div>\n");
  expect(ensureSyntaxTree(state, state.doc.length)?.toString()).toBe(
    "Document(HTMLBlock)",
  );
});
