import { expect, test } from "bun:test";

import {
  applyTextEdits,
  planSingleReplacement,
  planTextReplacements,
  searchProject,
} from "./search";

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
  expect(result.error).toBeUndefined();
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
  const intro = sources.get("sections/intro.tex")!;
  for (const match of result.files[1]?.matches ?? []) {
    expect(intro.slice(match.from, match.to)).toBe(match.match);
  }
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

test("regex mode finds pattern matches and previews capture-group replacements", () => {
  const result = searchProject(sources, "\\\\ref\\{([^}]+)\\}", {
    regex: true,
    replacement: "\\eqref{$1}",
  });
  expect(result.error).toBeUndefined();
  expect(result.total).toBe(3);
  expect(result.files[0]?.matches.map((m) => m.replacement)).toEqual([
    "\\eqref{FIG:plot}",
    "\\eqref{fig:plot}",
  ]);
  expect(result.files[1]?.matches.map((m) => m.replacement)).toEqual([
    "\\eqref{fig:plot}",
  ]);
});

test("invalid regex patterns report an error and return no matches or edits", () => {
  const search = searchProject(sources, "[unclosed", { regex: true });
  expect(search.error).toContain("Invalid regular expression");
  expect(search.files).toEqual([]);
  expect(search.total).toBe(0);

  const plan = planTextReplacements("hello", "[unclosed", "world", {
    regex: true,
  });
  expect(plan.error).toContain("Invalid regular expression");
  expect(plan.edits).toEqual([]);
});

test("literal replacement preserves dollar signs and LaTeX math verbatim", () => {
  const text = "Use foo and FOO here.";
  const plan = planTextReplacements(text, "foo", "$1 + $$ + $x$");
  expect(plan.error).toBeUndefined();
  expect(applyTextEdits(text, plan.edits)).toBe(
    "Use $1 + $$ + $x$ and $1 + $$ + $x$ here.",
  );
});

test("regex replacement supports numbered, named, and special substitutions across CRLF", () => {
  const text = "See \\ref{fig:a}.\r\nAnd \\ref{tab:b}!";
  const plan = planTextReplacements(
    text,
    "\\\\ref\\{(?<kind>[a-z]+):(?<name>[a-z]+)\\}",
    "\\cref{$<kind>-$2} ($$, $&)",
    { regex: true },
  );
  expect(plan.error).toBeUndefined();
  expect(applyTextEdits(text, plan.edits)).toBe(
    "See \\cref{fig-a} ($, \\ref{fig:a}).\r\nAnd \\cref{tab-b} ($, \\ref{tab:b})!",
  );
});

test("single-match replacement guards against stale offsets", () => {
  const intro = sources.get("sections/intro.tex")!;
  const result = searchProject([["sections/intro.tex", intro]], "fig:plot", {
    replacement: "fig:chart",
  });
  const second = result.files[0]?.matches[1];
  expect(second).toBeDefined();
  if (!second || second.replacement === undefined) return;
  const edit = planSingleReplacement(intro, second, second.replacement);
  expect(edit).not.toBeNull();
  expect(applyTextEdits(intro, [edit!])).toBe(
    "See \\ref{fig:plot}.\r\nNo match here\n\\label{fig:chart}",
  );
  // If the file shifted before applying, the stale match is rejected.
  const shifted = `header\n${intro}`;
  expect(planSingleReplacement(shifted, second, "fig:chart")).toBeNull();
});

test("zero-length regex matches do not loop and can insert text", () => {
  const text = "one\ntwo";
  const plan = planTextReplacements(text, "^", "% ", { regex: true });
  expect(plan.error).toBeUndefined();
  expect(applyTextEdits(text, plan.edits)).toBe("% one\n% two");
});
