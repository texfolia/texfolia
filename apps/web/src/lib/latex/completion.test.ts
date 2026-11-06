import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CompletionContext,
  insertCompletionText,
} from "@codemirror/autocomplete";
import { indentUnit } from "@codemirror/language";
import { EditorState, type Transaction } from "@uiw/react-codemirror";

import { emptyAnalysis } from "./analysis";
import { latexCompletion } from "./completion";

async function complete(doc: string, label: string, pos = doc.length) {
  let state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [indentUnit.of("  ")],
  });
  const result = await latexCompletion(
    () => emptyAnalysis,
    [],
  )(new CompletionContext(state, pos, true));
  const option = result?.options.find((option) => option.label === label);
  assert.ok(result && option, `Expected ${label} completion for ${doc}`);
  const to = result.to ?? pos;
  if (typeof option.apply === "function") {
    Reflect.apply(option.apply, undefined, [
      {
        get state() {
          return state;
        },
        dispatch(transaction: Transaction) {
          state = transaction.state;
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

test("begin completion works after typing the closing brace", async () => {
  const state = await complete("\\begin{doc}", "document");
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

test("command completions still replace only the command", async () => {
  const state = await complete("\\sec", "\\section");
  assert.equal(state.doc.toString(), "\\section");
});
