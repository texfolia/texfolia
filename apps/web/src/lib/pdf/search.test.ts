import { expect, test } from "bun:test";

import { findInPage, markItem, pageText } from "./search";

const item = (str: string, hasEOL = false) => ({ str, hasEOL, x: 0.1, y: 0.2 });
const find = (items: ReturnType<typeof item>[], query: string) =>
  findInPage(pageText(3, items), query).map(({ ranges }) => ranges);

test("matches ignore case and spacing, and map back to their items", () => {
  expect(find([item("The Main  Theorem")], "main theorem")).toEqual([
    [{ item: 0, from: 4, to: 17 }],
  ]);
  expect(find([item("aa aa")], "A")).toHaveLength(4);
  expect(find([item("text")], "   ")).toEqual([]);
  expect(findInPage(pageText(3, [item("text")]), "t")[0]).toMatchObject({
    page: 3,
    x: 0.1,
    y: 0.2,
  });
});

test("matches span items and line ends", () => {
  expect(
    find(
      [item("Fer"), item("mat’s"), item(" last", true), item("theorem")],
      "fermat’s last theorem",
    ),
  ).toEqual([
    [
      { item: 0, from: 0, to: 3 },
      { item: 1, from: 0, to: 5 },
      { item: 2, from: 0, to: 5 },
      { item: 3, from: 0, to: 7 },
    ],
  ]);
});

test("a word broken over two lines is found with and without its hyphen's line end", () => {
  const items = [item("an exam-", true), item("ple of it")];
  expect(find(items, "example")).toEqual([
    [
      { item: 0, from: 3, to: 7 },
      { item: 1, from: 0, to: 3 },
    ],
  ]);
  // A hyphen before a capital is the author's own.
  expect(
    find([item("Cauchy-", true), item("Schwarz")], "cauchy- schwarz"),
  ).toHaveLength(1);
});

test("marked items escape their text", () => {
  expect(
    markItem("a<b & c", [
      { from: 0, to: 1, current: true },
      { from: 2, to: 3, current: false },
    ]),
  ).toBe('<mark data-current="true">a</mark>&lt;<mark>b</mark> &amp; c');
});
