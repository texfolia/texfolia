import { expect, test } from "bun:test";

import {
  type AppliedEdit,
  applyChanges,
  assistantChange,
  editContext,
  revertEdits,
} from "./revert";

/** Applies edits as `edit_file` does, and returns what its result keeps. */
function applied(
  text: string,
  edits: { oldText: string; newText: string }[],
): { text: string; edits: AppliedEdit[] } {
  const sorted = edits
    .map((edit, index) => ({ ...edit, index, at: text.indexOf(edit.oldText) }))
    .sort((a, b) => a.at - b.at);
  let updated = "";
  let cursor = 0;
  const ranges: { from: number; to: number }[] = [];
  for (const { at, oldText, newText, index } of sorted) {
    updated += text.slice(cursor, at);
    ranges[index] = {
      from: updated.length,
      to: updated.length + newText.length,
    };
    updated += newText;
    cursor = at + oldText.length;
  }
  updated += text.slice(cursor);
  const context = editContext(updated, ranges);
  return {
    text: updated,
    edits: edits.map((edit, index) => ({ ...edit, ...context[index]! })),
  };
}
function revert(text: string, edits: AppliedEdit[]) {
  const { changes, outcomes } = revertEdits(text, edits);
  return { text: applyChanges(text, changes), outcomes };
}
const document = Array.from(
  { length: 20 },
  (_, index) => `Paragraph ${index} of the document, which says a thing.\n`,
).join("");

test("edits revert exactly, one at a time or together, in any order", () => {
  const saved = applied(document, [
    { oldText: "Paragraph 12 of", newText: "Section 12 of" },
    { oldText: "Paragraph 3 of", newText: "" },
    { oldText: "Paragraph 4 of", newText: "Paragraph 4 of the first half of" },
  ]);
  expect(saved.text).not.toBe(document);
  expect(revert(saved.text, saved.edits)).toEqual({
    text: document,
    outcomes: ["reverted", "reverted", "reverted"],
  });
  let text = saved.text;
  for (const edit of saved.edits) text = revert(text, [edit]).text;
  expect(text).toBe(document);
});

test("reverting again changes nothing", () => {
  const saved = applied(document, [
    { oldText: "Paragraph 12 of", newText: "Section 12 of" },
    { oldText: "Paragraph 3 of", newText: "" },
  ]);
  expect(revert(document, saved.edits)).toEqual({
    text: document,
    outcomes: ["already", "already"],
  });
});

test("collaborators' edits elsewhere and close by are kept", () => {
  const saved = applied(document, [
    { oldText: "Paragraph 12 of the document", newText: "This passage" },
  ]);
  const edited = `Added first.\n${saved.text}`.replace(
    "This passage, which says a thing.",
    "This passage, which says one thing.",
  );
  expect(revert(edited, saved.edits)).toEqual({
    text: `Added first.\n${document}`.replace(
      "Paragraph 12 of the document, which says a thing.",
      "Paragraph 12 of the document, which says one thing.",
    ),
    outcomes: ["reverted"],
  });
});

test("a passage that was changed is left alone", () => {
  const saved = applied(document, [
    { oldText: "Paragraph 12 of the document", newText: "This long passage" },
    { oldText: "Paragraph 5 of the document", newText: "Another passage here" },
  ]);
  const edited = saved.text.replace("This long passage", "This short passage");
  const result = revert(edited, saved.edits);
  expect(result.outcomes).toEqual(["conflict", "reverted"]);
  expect(result.text).toContain("This short passage");
  expect(result.text).toContain("Paragraph 5 of the document");
});

test("text that now appears twice is not guessed at", () => {
  const saved = applied("alpha beta gamma", [
    { oldText: "beta", newText: "x" },
  ]);
  expect(saved.text).toBe("alpha x gamma");
  // Same word elsewhere: the surroundings decide.
  expect(revert("x x alpha x gamma", saved.edits).outcomes).not.toEqual([
    "already",
  ]);
  expect(revert("one x two x three", saved.edits)).toEqual({
    text: "one x two x three",
    outcomes: ["conflict"],
  });
  const line = "The same line appears again and again in this document.\n";
  const repeated = applied(`${line}UNIQUE\n${line}`, [
    { oldText: "UNIQUE\n", newText: "" },
  ]);
  expect(revert(`${repeated.text}${repeated.text}`, repeated.edits)).toEqual({
    text: `${repeated.text}${repeated.text}`,
    outcomes: ["conflict"],
  });
});

test("edits at the edges of a file and of everything in it revert", () => {
  for (const [before, oldText, newText] of [
    ["abc", "abc", ""],
    ["abc", "abc", "something else"],
    ["abc def", "abc", ""],
    ["abc def", "def", "def ghi"],
    ["aa", "aa", "aaaa"],
  ] as const) {
    const saved = applied(before, [{ oldText, newText }]);
    expect(revert(saved.text, saved.edits)).toEqual({
      text: before,
      outcomes: ["reverted"],
    });
  }
});

test("later edits of the same passage must be reverted first", () => {
  const first = applied(document, [
    { oldText: "Paragraph 12 of the document", newText: "The first version" },
  ]);
  const second = applied(first.text, [
    { oldText: "The first version", newText: "The second version" },
  ]);
  expect(revert(second.text, first.edits).outcomes).toEqual(["conflict"]);
  const undone = revert(second.text, second.edits);
  expect(revert(undone.text, first.edits)).toEqual({
    text: document,
    outcomes: ["reverted"],
  });
});

test("only finished calls that recorded enough become changes", () => {
  const call = {
    name: "edit_file",
    arguments: JSON.stringify({
      path: "main.tex",
      version: null,
      edits: [{ oldText: "a", newText: "b" }],
    }),
  };
  const content = JSON.stringify({
    path: "main.tex",
    nodeId: "node",
    version: "v2",
    context: [{ before: "x", after: "y" }],
  });
  expect(assistantChange(call, { content, state: "complete" })).toEqual({
    kind: "edit",
    path: "main.tex",
    nodeId: "node",
    edits: [{ oldText: "a", newText: "b", before: "x", after: "y" }],
  });
  expect(assistantChange(call, undefined)).toBeNull();
  expect(assistantChange(call, { content, state: "error" })).toBeNull();
  for (const old of [
    '{"path":"main.tex","version":"v2","saved":true}',
    '{"error":"File changed. Read it again before editing."}',
    "not json",
  ])
    expect(
      assistantChange(call, { content: old, state: "complete" }),
    ).toBeNull();
  expect(
    assistantChange(
      { name: "read_file", arguments: '{"path":"main.tex"}' },
      { content: "{}", state: "complete" },
    ),
  ).toBeNull();
  expect(
    assistantChange(
      { name: "create_file", arguments: '{"path":"a.tex"}' },
      { content: '{"path":"a.tex","nodeId":"a"}', state: "complete" },
    ),
  ).toEqual({ kind: "create", path: "a.tex", nodeId: "a", content: "" });
});
