import { expect, test } from "bun:test";

import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

const rank = (query: string, ...texts: string[]) =>
  fuzzyFilter(query, texts, (text) => text).map(({ item }) => item);

test("characters match in order, ignoring case and spaces", () => {
  expect(fuzzyMatch("ch2", "chapters/Chapter-2.tex")).not.toBeNull();
  expect(fuzzyMatch("xet", "main.tex")).toBeNull();
  expect(fuzzyMatch("main tex", "MAIN.tex")?.positions).toEqual([
    0, 1, 2, 3, 5, 6, 7,
  ]);
  expect(fuzzyMatch("", "main.tex")).toEqual({ score: 0, positions: [] });
});

test("file names, word starts and runs rank first", () => {
  expect(
    rank("intro", "introduction-notes/main.tex", "chapters/intro.tex"),
  ).toEqual(["chapters/intro.tex", "introduction-notes/main.tex"]);
  expect(rank("rm", "form.tex", "related-methods.tex")[0]).toBe(
    "related-methods.tex",
  );
  expect(rank("main", "main-appendix.tex", "main.tex")[0]).toBe("main.tex");
  expect(fuzzyMatch("tex", "text/index.tex")?.positions).toEqual([11, 12, 13]);
});

test("an empty query keeps the given order", () => {
  expect(rank("  ", "b", "a")).toEqual(["b", "a"]);
});

test("long text stays fast", () => {
  const started = performance.now();
  for (let index = 0; index < 1000; index++)
    fuzzyMatch("chapter", `some/long/path/to/chapter-${index}/file.tex`);
  expect(performance.now() - started).toBeLessThan(1000);
});
