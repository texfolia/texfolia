import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CompletionContext,
  type CompletionSource,
  insertCompletionText,
} from "@codemirror/autocomplete";
import { indentUnit } from "@codemirror/language";
import {
  EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";

import { emptyAnalysis } from "./analysis.js";
import { latexCompletion } from "./completion.js";
import { editorLanguage } from "./language.js";

async function complete(doc: string, label: string, pos = doc.length) {
  let state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [
      indentUnit.of("  "),
      editorLanguage({
        filename: "main.tex",
        completion: latexCompletion(
          () => ({
            ...emptyAnalysis,
            labels: ["sec:intro"],
            citations: ["knuth1984"],
          }),
          ["chapters/intro.tex", "image.png"],
        ),
        getProblems: () => [],
        publishSyntax: () => {},
      }),
    ],
  });
  const context = new CompletionContext(state, pos, true);
  const results = await Promise.all(
    state
      .languageDataAt<CompletionSource>("autocomplete", pos)
      .map((source) => source(context)),
  );
  const result = results.find((result) =>
    result?.options.some((option) => option.label === label),
  );
  const option = result?.options.find((option) => option.label === label);
  assert.ok(result && option, `Expected ${label} completion for ${doc}`);
  const to = result.to ?? pos;
  if (typeof option.apply === "function") {
    Reflect.apply(option.apply, undefined, [
      {
        get state() {
          return state;
        },
        dispatch(transaction: Transaction | TransactionSpec) {
          state =
            transaction instanceof Transaction
              ? transaction.state
              : state.update(transaction).state;
        },
      },
      option,
      result.from,
      to,
    ]);
  } else {
    state = state.update(
      insertCompletionText(
        state,
        option.apply ?? option.label,
        result.from,
        to,
      ),
    ).state;
  }
  return state;
}

test("begin completion inserts a matching end and places the caret in the body", async () => {
  const state = await complete("\\begin{doc", "document");
  assert.equal(state.doc.toString(), "\\begin{document}\n  \n\\end{document}");
  assert.equal(state.selection.main.head, "\\begin{document}\n  ".length);
});

test("begin completion consumes the auto-closed brace", async () => {
  const state = await complete(
    "\\begin{doc}",
    "document",
    "\\begin{doc".length,
  );
  assert.equal(state.doc.toString(), "\\begin{document}\n  \n\\end{document}");
});

test("environment snippets preserve surrounding indentation and text", async () => {
  const state = await complete(
    "  \\begin{equ} text",
    "equation",
    "  \\begin{equ".length,
  );
  assert.equal(
    state.doc.toString(),
    "  \\begin{equation}\n    \n  \\end{equation} text",
  );
});

test("end completion inserts only the environment name", async () => {
  const state = await complete("\\end{doc}", "document", "\\end{doc".length);
  assert.equal(state.doc.toString(), "\\end{document}");
});

test("built-in command completion places the caret inside its argument", async () => {
  const state = await complete("\\sec", "\\section");
  assert.equal(state.doc.toString(), "\\section{}");
  assert.equal(state.selection.main.head, "\\section{".length);
});

test("project labels complement built-in command completions", async () => {
  const state = await complete(
    "\\ref{sec:i}",
    "sec:intro",
    "\\ref{sec:i".length,
  );
  assert.equal(state.doc.toString(), "\\ref{sec:intro}");
});

test("project bibliography keys complete inside a citation list", async () => {
  const state = await complete(
    "\\cite{other, kn}",
    "knuth1984",
    "\\cite{other, kn".length,
  );
  assert.equal(state.doc.toString(), "\\cite{other, knuth1984}");
});

test("project file suggestions keep the closing brace", async () => {
  const state = await complete(
    "\\input{chap}",
    "chapters/intro.tex",
    "\\input{chap".length,
  );
  assert.equal(state.doc.toString(), "\\input{chapters/intro.tex}");
});
