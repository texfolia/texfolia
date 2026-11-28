import { expect, test } from "bun:test";

import { diffCounts, diffReplacement } from "./diff";

const shown = (oldText: string, newText: string) =>
  diffReplacement(oldText, newText).map(
    ({ kind, parts }) =>
      `${{ same: " ", removed: "-", added: "+" }[kind]}${parts
        .map(({ text, changed }) => (changed ? `[${text}]` : text))
        .join("")}`,
  );

test("changed lines mark the words that changed", () => {
  expect(shown("one\ntwo words\nthree\n", "one\ntwo terms\nthree\n")).toEqual([
    " one",
    "-two [words]",
    "+two [terms]",
    " three",
  ]);
});

test("insertions and deletions are whole lines", () => {
  expect(shown("", "a\n\nb")).toEqual(["+a", "+", "+b"]);
  expect(shown("a\nb\n", "")).toEqual(["-a", "-b"]);
  expect(shown("same", "same")).toEqual([" same"]);
});

test("long passages are compared by line only, and counts cover lines", () => {
  const long = "word ".repeat(2000);
  const diff = diffReplacement(long, `${long}more`);
  expect(diffCounts(diff)).toEqual({ added: 1, removed: 1 });
  expect(diff.every(({ parts }) => parts.every((part) => !part.changed))).toBe(
    true,
  );
});
