import { expect, test } from "bun:test";

import { searchProject } from "./project-search";

const sources = new Map([
  [
    "sections/intro.tex",
    "See \\ref{fig:plot}.\r\nNo match here\n\\label{fig:plot}",
  ],
  ["main.tex", "\\input{sections/intro}\n\\ref{FIG:plot} and \\ref{fig:plot}"],
  ["refs.bib", "@article{plot2024,}"],
]);

test("lists literal matches by path with line, column and highlight offsets", () => {
  const result = searchProject(sources, "fig:plot");
  expect(result.total).toBe(4);
  expect(result.truncated).toBe(false);
  expect(result.files.map((file) => file.path)).toEqual([
    "main.tex",
    "sections/intro.tex",
  ]);
  expect(
    result.files[1]?.matches.map(({ line, column }) => [line, column]),
  ).toEqual([
    [1, 10],
    [3, 8],
  ]);
  const [first] = result.files[0]?.matches ?? [];
  expect(first?.preview.slice(first.start, first.end)).toBe("FIG:plot");
});

test("match case and regex characters are treated literally", () => {
  expect(searchProject(sources, "FIG", { matchCase: true }).total).toBe(1);
  expect(searchProject(sources, "\\ref{").total).toBe(3);
  expect(searchProject(sources, ".*").total).toBe(0);
  expect(searchProject(sources, "").files).toEqual([]);
});

test("long lines are trimmed around the match", () => {
  const line = `${"a".repeat(100)}needle${"b".repeat(100)}`;
  const [match] =
    searchProject([["long.tex", line]], "needle").files[0]?.matches ?? [];
  expect(match?.preview.startsWith("…")).toBe(true);
  expect(match?.preview.endsWith("…")).toBe(true);
  expect(match?.preview.slice(match.start, match.end)).toBe("needle");
  expect(match?.column).toBe(101);
});

test("the result limit stops the scan and reports truncation", () => {
  const result = searchProject(sources, "plot", { limit: 2 });
  expect(result.total).toBe(2);
  expect(result.truncated).toBe(true);
  expect(result.files.flatMap((file) => file.matches)).toHaveLength(2);
});
