import assert from "node:assert/strict";
import { test } from "node:test";

import { history, undo } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  type StateCommand,
} from "@codemirror/state";

import { applyLatexHeading, toggleLatexCommand } from "./commands.js";

function editor(
  doc: string,
  selection = EditorSelection.single(0, doc.length),
) {
  let state = EditorState.create({
    doc,
    selection,
    extensions: [history(), EditorState.allowMultipleSelections.of(true)],
  });
  return {
    get state() {
      return state;
    },
    run(command: StateCommand) {
      command({
        state,
        dispatch: (transaction) => {
          state = transaction.state;
        },
      });
    },
  };
}

test("bold toggles the selection and undo restores the original source", () => {
  const view = editor("Hello world", EditorSelection.single(6, 11));
  view.run(toggleLatexCommand("textbf"));
  assert.equal(view.state.doc.toString(), "Hello \\textbf{world}");
  assert.equal(
    view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    ),
    "world",
  );
  view.run(undo);
  assert.equal(view.state.doc.toString(), "Hello world");
  view.run(toggleLatexCommand("textbf"));
  view.run(toggleLatexCommand("textbf"));
  assert.equal(view.state.doc.toString(), "Hello world");
});

test("italic at the caret inserts braces and places typing inside them", () => {
  const view = editor("Hello ", EditorSelection.single(6));
  view.run(toggleLatexCommand("textit"));
  assert.equal(view.state.doc.toString(), "Hello \\textit{}");
  assert.equal(view.state.selection.main.head, 14);
});

test("formatting handles multiple and backwards selections", () => {
  const view = editor(
    "one two",
    EditorSelection.create([
      EditorSelection.range(3, 0),
      EditorSelection.range(4, 7),
    ]),
  );
  view.run(toggleLatexCommand("underline"));
  assert.equal(view.state.doc.toString(), "\\underline{one} \\underline{two}");
  view.run(toggleLatexCommand("underline"));
  assert.equal(view.state.doc.toString(), "one two");
});

test("selecting a complete formatting command and toggling removes it", () => {
  const view = editor("\\textbf{hello}");
  view.run(toggleLatexCommand("textbf"));
  assert.equal(view.state.doc.toString(), "hello");
});

test("formatting a selection of adjacent commands keeps the LaTeX braces intact", () => {
  const view = editor("\\textbf{one} and \\textbf{two}");
  view.run(toggleLatexCommand("textbf"));
  assert.equal(
    view.state.doc.toString(),
    "\\textbf{\\textbf{one} and \\textbf{two}}",
  );
  view.run(toggleLatexCommand("textbf"));
  assert.equal(view.state.doc.toString(), "\\textbf{one} and \\textbf{two}");
});

test("heading commands keep the caret inside the heading for continued typing", () => {
  const view = editor("Hello", EditorSelection.single(2));
  view.run(applyLatexHeading("section"));
  assert.equal(view.state.doc.toString(), "\\section{Hello}");
  assert.equal(view.state.selection.main.head, 11);
  view.run(applyLatexHeading("subsection"));
  assert.equal(view.state.selection.main.head, 14);
  view.run(applyLatexHeading(""));
  assert.equal(view.state.selection.main.head, 2);
  const empty = editor("", EditorSelection.single(0));
  empty.run(applyLatexHeading("section"));
  assert.equal(empty.state.selection.main.head, 9);
});

test("headings replace the existing level, retain nested LaTeX, and return to normal text", () => {
  const view = editor("  \\section{Hello \\textbf{world}}");
  view.run(applyLatexHeading("subsection"));
  assert.equal(
    view.state.doc.toString(),
    "  \\subsection{Hello \\textbf{world}}",
  );
  view.run(applyLatexHeading(""));
  assert.equal(view.state.doc.toString(), "  Hello \\textbf{world}");
});

test("headings apply to selected lines without changing the following line", () => {
  const view = editor("One\nTwo\nThree", EditorSelection.single(0, 8));
  view.run(applyLatexHeading("section"));
  assert.equal(
    view.state.doc.toString(),
    "\\section{One}\n\\section{Two}\nThree",
  );
  view.run(undo);
  assert.equal(view.state.doc.toString(), "One\nTwo\nThree");
});
