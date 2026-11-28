import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CompletionContext } from "@codemirror/autocomplete";
import { ensureSyntaxTree, foldable, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fileTests } from "@lezer/generator/test";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";

import {
  bibtex,
  bibtexLanguage,
  bst,
  bstLanguage,
  isLatexFilename,
  languageForFilename,
  latex,
  latexCompletionSource,
  latexLanguage,
  latexLinter,
  latexTags,
  texLanguageDescriptions,
} from "./index.js";

function lint(doc: string, extensions: Extension[] = [latex()]) {
  const state = EditorState.create({ doc, extensions });
  const check = latexLinter();
  return check({ state } as EditorView);
}

function highlighted(doc: string, extension: Extension) {
  const state = EditorState.create({ doc, extensions: [extension] });
  const tree = ensureSyntaxTree(state, doc.length, 500);
  if (!tree) throw new Error("Parser did not finish");
  const spans: { text: string; style: string }[] = [];
  highlightTree(
    tree,
    tagHighlighter([
      { tag: latexTags.command, class: "command" },
      { tag: latexTags.environment, class: "environment" },
      { tag: latexTags.math, class: "math" },
      { tag: latexTags.argument, class: "argument" },
      { tag: latexTags.option, class: "option" },
      { tag: latexTags.bibField, class: "field" },
      { tag: latexTags.verbatim, class: "verbatim" },
      { tag: tags.comment, class: "comment" },
      { tag: tags.string, class: "string" },
      { tag: tags.keyword, class: "keyword" },
      { tag: tags.standard(tags.variableName), class: "builtin" },
      { tag: tags.number, class: "number" },
    ]),
    (from, to, style) => spans.push({ text: doc.slice(from, to), style }),
  );
  return spans;
}

describe("LaTeX grammar corpus", () => {
  const cases = readFileSync(
    join(import.meta.dir, "../test/cases.txt"),
    "utf8",
  );
  for (const { name, run } of fileTests(cases, "cases.txt")) {
    test(name, () => run(latexLanguage.parser));
  }
});

describe("BibTeX grammar corpus", () => {
  const cases = readFileSync(
    join(import.meta.dir, "../test/bibtex.txt"),
    "utf8",
  );
  for (const { name, run } of fileTests(cases, "bibtex.txt")) {
    test(name, () => run(bibtexLanguage.parser));
  }
});

test("highlights math environment body as math and starred EnvName as environment", () => {
  const doc = "\\begin{equation*}\n  a + b = c\n\\end{equation*}";
  const spans = highlighted(doc, latexLanguage);
  expect(spans).toContainEqual({ text: "\\begin", style: "command" });
  expect(spans).toContainEqual({ text: "equation*", style: "environment" });
  expect(
    spans.some((span) => span.style === "math" && span.text.includes("a")),
  ).toBe(true);
});

test("highlights inline verbatim and verbatim environments without leaking math or comments", () => {
  const doc = String.raw`Text \verb|$x { %| end.
\begin{verbatim}
% still verbatim
$unclosed {
\end{verbatim}`;
  const spans = highlighted(doc, latexLanguage);
  expect(spans).toContainEqual({ text: "\\verb|$x { %|", style: "verbatim" });
  expect(
    spans.some(
      (span) =>
        span.style === "verbatim" && span.text.includes("% still verbatim"),
    ),
  ).toBe(true);
  expect(spans.some((span) => span.style === "comment")).toBe(false);
  expect(spans.some((span) => span.style === "math")).toBe(false);
});

test("embeds nested code parsers inside minted and lstlisting via parseMixed", () => {
  const doc = String.raw`\begin{minted}{bibtex}
@article{knuth1984,
  author = {Knuth}
}
\end{minted}
\begin{lstlisting}[language=bibtex]
@book{lamport1994,
  title = {LaTeX}
}
\end{lstlisting}`;
  const support = latex({
    enableAutocomplete: false,
    codeLanguages: (info) => (info === "bibtex" ? bibtexLanguage : null),
  });
  const spans = highlighted(doc, support);
  expect(spans).toContainEqual({ text: "@article", style: "keyword" });
  expect(spans).toContainEqual({ text: "author", style: "field" });
  expect(spans).toContainEqual({ text: "@book", style: "keyword" });
  expect(spans).toContainEqual({ text: "title", style: "field" });
});

test("folds LaTeX environments and BibTeX entries", () => {
  const texDoc =
    "\\begin{document}\n\\begin{itemize}\n\\item a\n\\end{document}";
  const texState = EditorState.create({
    doc: texDoc,
    extensions: [latexLanguage],
  });
  const docLine = texState.doc.line(1);
  expect(foldable(texState, docLine.from, docLine.to)).not.toBeNull();

  const bibDoc = "@article{knuth1984,\n  author = {Knuth},\n  year = 1984\n}";
  const bibState = EditorState.create({
    doc: bibDoc,
    extensions: [bibtex()],
  });
  const bibLine = bibState.doc.line(1);
  expect(foldable(bibState, bibLine.from, bibLine.to)).not.toBeNull();
});

test("highlights BibTeX style (.bst) keywords, builtins, strings, numbers, and comments", () => {
  const doc = `% Style comment
FUNCTION {format.title}
{ title empty$
    { "" }
    { title #1 global.max$ substring$ }
  if$
}`;
  const spans = highlighted(doc, bst());
  expect(spans).toContainEqual({ text: "% Style comment", style: "comment" });
  expect(spans).toContainEqual({ text: "FUNCTION", style: "keyword" });
  expect(spans).toContainEqual({ text: "empty$", style: "builtin" });
  expect(spans).toContainEqual({ text: "#1", style: "number" });
  expect(spans).toContainEqual({ text: '""', style: "string" });
  expect(bstLanguage.name).toBe("bst");
});

test("resolves language support across TeX, BibTeX, and BibTeX style extensions", () => {
  expect(texLanguageDescriptions.length).toBe(3);
  for (const ext of [
    "main.tex",
    "paper.ltx",
    "custom.sty",
    "thesis.cls",
    "numeric.bbx",
    "authoryear.cbx",
    "english.lbx",
    "pkg.dtx",
    "pkg.ins",
  ]) {
    expect(isLatexFilename(ext)).toBe(true);
    expect(languageForFilename(ext)?.language.name).toBe("latex");
  }
  expect(isLatexFilename("refs.bib")).toBe(false);
  expect(languageForFilename("refs.bib")?.language.name).toBe("bibtex");
  expect(languageForFilename("plain.bst")?.language.name).toBe("bst");
  expect(languageForFilename("notes.md")).toBeNull();
});

test("linter passes valid LaTeX including verbatim, comments, and class macros", () => {
  const doc = String.raw`% Unmatched { and \begin{foo}
\documentclass{article}
\makeatletter
\newcommand{\my@cmd}[1]{#1}
\makeatother
\begin{document}
\begin{equation*}
  a + b = c
\end{equation*}
Inline $x + y$, display \[z\], and \verb|{unclosed $ |.
\begin{verbatim}
\begin{unclosed} { $
\end{verbatim}
\end{document}`;
  expect(lint(doc)).toEqual([]);
});

test("linter reports mismatched and unclosed environments, braces, and math", () => {
  expect(lint("\\begin{itemize}\n\\end{enumerate}")[0]?.message).toContain(
    "Mismatched \\end{enumerate}",
  );
  expect(lint("\\begin{document}\nHello")[0]?.message).toContain(
    "Unclosed environment",
  );
  expect(
    lint("\\begin{document}\n\\begin{itemize}\n\\item a\n\\end{document}").map(
      (d) => d.message,
    ),
  ).toEqual(["Unclosed environment “itemize”"]);
  expect(lint("\\end{orphan}")[0]?.message).toContain(
    "Unexpected \\end{orphan}",
  );
  expect(lint("\\begin{verbatim}\nno end")[0]?.message).toContain(
    "Unclosed environment “verbatim”",
  );
  expect(lint("Hello \\textbf{world")[0]?.message).toContain("Unclosed brace");
  expect(lint("Hello }")[0]?.message).toContain("Unmatched closing brace");
  expect(lint("Math $x + y")[0]?.message).toContain("Unclosed math delimiter");
  expect(lint("Math \\(x\\]")[0]?.message).toContain(
    "Mismatched math delimiter",
  );
  expect(lint("Hello \\textbf{world", [])[0]?.message).toContain(
    "Unclosed brace",
  );
});

test("completion suggests environments, document commands, and package/biblatex commands", async () => {
  const doc = "\\begin{doc";
  const state = EditorState.create({ doc });
  const result = await latexCompletionSource(
    new CompletionContext(state, doc.length, true),
  );
  expect(result?.options.some((opt) => opt.label === "document")).toBe(true);

  const cmdDoc = "\\ProvidesP";
  const cmdState = EditorState.create({ doc: cmdDoc });
  const cmdResult = await latexCompletionSource(
    new CompletionContext(cmdState, cmdDoc.length, true),
  );
  expect(
    cmdResult?.options.some((opt) => opt.label === "\\ProvidesPackage"),
  ).toBe(true);

  const biblatexDoc = "\\DeclareBib";
  const biblatexState = EditorState.create({ doc: biblatexDoc });
  const biblatexResult = await latexCompletionSource(
    new CompletionContext(biblatexState, biblatexDoc.length, true),
  );
  expect(
    biblatexResult?.options.some(
      (opt) => opt.label === "\\DeclareBibliographyDriver",
    ),
  ).toBe(true);
});

test("exposes custom highlight tags", () => {
  expect(latexTags.command).toBeDefined();
  expect(latexTags.environment).toBeDefined();
  expect(latexTags.bibField).toBeDefined();
  expect(latexTags.verbatim).toBeDefined();
  const state = EditorState.create({
    doc: "@article{knuth1984,\n  author = {Knuth},\n  year = 1984\n}",
    extensions: [bibtexLanguage],
  });
  expect(syntaxTree(state).length).toBeGreaterThan(0);
});
