import { expect, test } from "bun:test";

import { countWords, wordEvents } from "./word-count.js";

function count(files: Record<string, string>, root = "main.tex") {
  return countWords(
    new Map(
      Object.entries(files).map(([path, text]) => [path, wordEvents(text)]),
    ),
    root,
  );
}
const body = (text: string) =>
  count({
    "main.tex": `\\documentclass{article}\n\\begin{document}\n${text}\n\\end{document}`,
  });

test("excludes commands, math, comments, verbatim and the preamble", () => {
  const words = count({
    "main.tex": String.raw`\documentclass{article}
\usepackage{amsmath} preamble words
\begin{document}
We study the well-known $x^2 + y$ problem and don't stop. % not counted
\begin{equation} E = mc^2 \text{energy} \end{equation}
Inline \(a+b\) and display \[c\] math, see~\cite{knuth} and \ref{sec}.
\verb|verbatim words| \textbf{bold} Caf\'e na\"{i}ve e.g. 3.14.
\begin{verbatim}
ignored verbatim block
\end{verbatim}
\end{document}
trailing words`,
  });
  // Matches texcount: 8 + 6 + bold, Café, naïve, e.g., 3.14.
  expect(words.text).toBe(19);
  expect(words.headers + words.captions).toBe(0);
});

test("counts headings, captions and footnotes separately, like texcount", () => {
  const words =
    body(String.raw`\section[Short]{An \emph{important} start}\label{s}
Text here.\footnote{Five words in a footnote.}
\begin{figure}[h]
  \includegraphics[width=\linewidth]{a.png}
  Float body words.
  \caption{A caption here.}
\end{figure}
\begin{tabular}{ll} Cell one & Cell two \\[2pt] \end{tabular}`);
  expect(words).toMatchObject({ text: 2, headers: 3, captions: 8, total: 13 });
  expect(words.sections).toMatchObject([
    { title: "Short", level: 2, line: 3, text: 2, headers: 3, captions: 8 },
  ]);
});

test("follows includes from the main file with per-file and per-section totals", () => {
  const words = count({
    "main.tex": String.raw`\documentclass{report}
\title{Two words}
\begin{document}
\begin{abstract} One two three. \end{abstract}
\chapter{Intro}
Main text.
\input{chapters/one}
\include{missing}
\end{document}`,
    "chapters/one.tex": String.raw`More words here.
\section{Nested}
\input{../main}
Last.`,
    "unused.tex": "Not part of the document.",
  });
  expect(words.total).toBe(2 + 1 + 3 + 1 + 2 + 3 + 1 + 1);
  expect(words.files).toEqual([
    { path: "main.tex", text: 5, headers: 4, captions: 0 },
    { path: "chapters/one.tex", text: 4, headers: 1, captions: 0 },
  ]);
  expect(
    words.sections.map(({ title, path, line, text, headers }) => ({
      title,
      path,
      line,
      words: text + headers,
    })),
  ).toEqual([
    { title: "Front matter", path: "main.tex", line: 1, words: 6 },
    { title: "Intro", path: "main.tex", line: 5, words: 6 },
    { title: "Nested", path: "chapters/one.tex", line: 2, words: 2 },
  ]);
});

test("counts a main file without a document environment in full", () => {
  expect(count({ "main.tex": "Just three words" }).total).toBe(3);
  expect(count({ "main.tex": "x" }, "other.tex").total).toBe(0);
});
