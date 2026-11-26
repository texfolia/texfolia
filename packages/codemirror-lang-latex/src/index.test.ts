import { expect, test } from "bun:test";

import { CompletionContext } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import {
  bibtexLanguage,
  latex,
  latexCompletionSource,
  latexLanguage,
  latexLinter,
  latexTags,
} from "./index.js";

function lint(doc: string) {
  const state = EditorState.create({ doc, extensions: [latex()] });
  const check = latexLinter();
  return check({ state } as EditorView);
}

test("parses environments, commands, math, comments, and arguments", () => {
  const doc = String.raw`% A comment
\documentclass[12pt]{article}
\begin{document}
Hello $x^2 + y$ and \[E = mc^2\].
\end{document}`;
  const state = EditorState.create({ doc, extensions: [latexLanguage] });
  const tree = syntaxTree(state);
  const names: string[] = [];
  tree.iterate({
    enter(node) {
      names.push(node.name);
    },
  });
  expect(names).toContain("Comment");
  expect(names).toContain("Command");
  expect(names).toContain("OptionalArgument");
  expect(names).toContain("BracedGroup");
  expect(names).toContain("Environment");
  expect(names).toContain("EnvName");
  expect(names).toContain("InlineMath");
  expect(names).toContain("DisplayMath");
});

test("exposes custom highlight tags and BibTeX language", () => {
  expect(latexTags.command).toBeDefined();
  expect(latexTags.environment).toBeDefined();
  expect(latexTags.bibField).toBeDefined();
  const state = EditorState.create({
    doc: "@article{knuth1984,\n  author = {Knuth},\n  year = 1984\n}",
    extensions: [bibtexLanguage],
  });
  expect(syntaxTree(state).length).toBeGreaterThan(0);
});

test("linter passes valid LaTeX including verbatim and comments", () => {
  const doc = String.raw`% Unmatched { and \begin{foo}
\documentclass{article}
\begin{document}
\begin{equation}
  a + b = c
\end{equation}
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
  expect(lint("Hello \\textbf{world")[0]?.message).toContain("Unclosed brace");
  expect(lint("Hello }")[0]?.message).toContain("Unmatched closing brace");
  expect(lint("Math $x + y")[0]?.message).toContain("Unclosed math delimiter");
  expect(lint("Math \\(x\\]")[0]?.message).toContain(
    "Mismatched math delimiter",
  );
});

test("completion suggests environments and commands", async () => {
  const doc = "\\begin{doc";
  const state = EditorState.create({ doc });
  const result = await latexCompletionSource(
    new CompletionContext(state, doc.length, true),
  );
  expect(result?.options.some((opt) => opt.label === "document")).toBe(true);

  const cmdDoc = "\\sec";
  const cmdState = EditorState.create({ doc: cmdDoc });
  const cmdResult = await latexCompletionSource(
    new CompletionContext(cmdState, cmdDoc.length, true),
  );
  expect(cmdResult?.options.some((opt) => opt.label === "\\section")).toBe(
    true,
  );
});
