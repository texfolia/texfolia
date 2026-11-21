import { expect, test } from "bun:test";

import { proseWords } from "./prose";

const words = (text: string) => proseWords(text).map(({ word }) => word);
const body = (text: string) =>
  words(
    `\\documentclass{article}\n\\begin{document}\n${text}\n\\end{document}`,
  );

test("checks prose and skips commands, math and comments", () => {
  expect(
    body(String.raw`We \emph{study} the $x^2 + \alpha$ \[ \beta \] case. % nott checked
\begin{equation} \gamma \end{equation} Done.`),
  ).toEqual(["We", "study", "the", "case", "Done"]);
});

test("skips label, reference, citation and environment arguments", () => {
  expect(
    body(String.raw`\section{Introduction}\label{sec:intro}
See \ref{fig:plot}, \eqref{eq:one} and \cite[p.~2]{knuth84,lamport}.
\begin{itemize}\item Text\end{itemize}
\begin{tabular}{lcr} Cell & Value \\ \end{tabular}
\url{https://example.com} \href{https://example.com}{Linked}`),
  ).toEqual(["Introduction", "See", "and", "Text", "Cell", "Value", "Linked"]);
});

test("skips the preamble except the title, and verbatim material", () => {
  expect(
    words(String.raw`\documentclass{article}
\usepackage{amsmath} preambel words
\title{Spelling Tests}
\author{Ada Lovelace}
\begin{document}
\verb|qwzx| Body \begin{verbatim}xyzzy\end{verbatim}
\end{document}
after`),
  ).toEqual(["Spelling", "Tests", "Body"]);
});

test("files without a document body are checked throughout", () => {
  expect(words("Chapter text\n\\input{other}")).toEqual(["Chapter", "text"]);
});

test("splits hyphenated words and decodes accent commands", () => {
  const text = String.raw`A well-known caf\'e, na\"{\i}ve e.g. don't`;
  const result = proseWords(text);
  expect(result.map(({ word }) => word)).toEqual([
    "well",
    "known",
    "café",
    "naïve",
    "don't",
  ]);
  const cafe = result[2];
  expect(text.slice(cafe?.from, cafe?.to)).toBe(String.raw`caf\'e`);
  const known = result[1];
  expect(text.slice(known?.from, known?.to)).toBe("known");
});

test("skips acronyms, numbers and single letters", () => {
  expect(words("The PDF has 12 pages, see v2 and a figure")).toEqual([
    "The",
    "has",
    "pages",
    "see",
    "and",
    "figure",
  ]);
});

test("skips keys, paths and units in package macros", () => {
  expect(
    body(String.raw`\inputminted{python}{code/main.py} We measured \SI{3}{\meter}
with \gls{svm} and \hyperref[sec:res]{linked text}.`),
  ).toEqual(["We", "measured", "with", "and", "linked", "text"]);
});

test("splits words at brace boundaries", () => {
  expect(body(String.raw`\foo{alpha}{beta} {T}he`)).toEqual([
    "alpha",
    "beta",
    "he",
  ]);
});
