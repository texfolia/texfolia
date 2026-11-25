import { expect, test } from "bun:test";

import { movedMainFile, projectMainFile } from "./main-file";

const paths = (...values: string[]) =>
  new Map(values.map((path) => [`id:${path}`, path]));

test("the chosen document is used while it exists", () => {
  const files = paths("main.tex", "thesis/book.tex");
  expect(projectMainFile(files, "thesis/book.tex")?.path).toBe(
    "thesis/book.tex",
  );
  expect(projectMainFile(files, "thesis/gone.tex")?.path).toBe("main.tex");
  expect(projectMainFile(files, null)?.path).toBe("main.tex");
});

test("without main.tex the outermost first file is used in any listing order", () => {
  for (const files of [
    paths("a/a.tex", "refs.bib", "paper.tex", "intro.tex"),
    paths("intro.tex", "paper.tex", "refs.bib", "a/a.tex"),
  ])
    expect(projectMainFile(files, null)).toEqual({
      id: "id:intro.tex",
      path: "intro.tex",
    });
  expect(projectMainFile(paths("a/main.tex"), null)?.path).toBe("a/main.tex");
});

test("only .tex files can be the main document", () => {
  expect(projectMainFile(paths("notes.md"), "notes.md")).toBeUndefined();
});

test("the choice follows renames of the file and its folders", () => {
  const before = new Map([
    ["root", "/"],
    ["folder", "thesis"],
    ["file", "thesis/book.tex"],
  ]);
  const after = new Map([
    ["root", "/"],
    ["folder", "draft"],
    ["file", "draft/book.tex"],
  ]);
  expect(movedMainFile("thesis/book.tex", before, after)).toBe(
    "draft/book.tex",
  );
  expect(movedMainFile("other.tex", before, after)).toBe("other.tex");
  expect(movedMainFile(null, before, after)).toBeNull();
});
