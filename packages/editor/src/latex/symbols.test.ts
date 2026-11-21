import assert from "node:assert/strict";
import { test } from "node:test";

import { history, undo } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  type StateCommand,
} from "@uiw/react-codemirror";

import {
  addLatexPackage,
  insertLatexSymbol,
  latexPreamble,
  latexSymbols,
  packageInsertion,
  searchLatexSymbols,
} from "./symbols";

function editor(
  doc: string,
  selection = EditorSelection.single(doc.length),
  readOnly = false,
) {
  let state = EditorState.create({
    doc,
    selection,
    extensions: [
      history(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(readOnly),
    ],
  });
  return {
    get state() {
      return state;
    },
    run(command: StateCommand) {
      return command({
        state,
        dispatch: (transaction) => {
          state = transaction.state;
        },
      });
    },
  };
}

function symbol(command: string) {
  const found = latexSymbols.find((entry) => entry.command === command);
  assert.ok(found, `Missing catalog entry ${command}`);
  return found;
}

test("bundled catalog has unique commands and usable display and package metadata", () => {
  assert.equal(
    new Set(latexSymbols.map((entry) => entry.command)).size,
    latexSymbols.length,
  );
  for (const entry of latexSymbols) {
    assert.match(entry.command, /^\\[a-zA-Z]+$/);
    assert.ok(entry.name && entry.category && entry.glyph);
    assert.ok(entry.package === null || /^[a-z]+$/.test(entry.package));
  }
});

test("search finds names, commands, categories, aliases and multiple terms without a network", () => {
  assert.ok(
    searchLatexSymbols("  ALPHA ").some((entry) => entry.command === "\\alpha"),
  );
  assert.ok(
    searchLatexSymbols("arrow").some(
      (entry) => entry.command === "\\rightarrow",
    ),
  );
  assert.ok(
    searchLatexSymbols("\\rightarrow").some(
      (entry) => entry.command === "\\rightarrow",
    ),
  );
  assert.ok(
    searchLatexSymbols("Greek letters").some(
      (entry) => entry.command === "\\beta",
    ),
  );
  assert.ok(
    searchLatexSymbols("quantifier").some(
      (entry) => entry.command === "\\forall",
    ),
  );
  assert.ok(
    searchLatexSymbols("double arrow").every((entry) =>
      entry.name.toLowerCase().includes("double"),
    ),
  );
  assert.equal(searchLatexSymbols("no-such-symbol").length, 0);
  assert.equal(searchLatexSymbols("").length, latexSymbols.length);
});

test("alpha and arrow insert at the caret, replace selections, and support undo", () => {
  const view = editor("$x + y$", EditorSelection.single(1, 2));
  view.run(insertLatexSymbol(symbol("\\alpha")));
  assert.equal(view.state.doc.toString(), "$\\alpha + y$");
  assert.equal(view.state.selection.main.head, 7);
  view.run(insertLatexSymbol(symbol("\\rightarrow")));
  assert.equal(view.state.doc.toString(), "$\\alpha\\rightarrow + y$");
  view.run(undo);
  assert.equal(view.state.doc.toString(), "$\\alpha + y$");
  view.run(undo);
  assert.equal(view.state.doc.toString(), "$x + y$");
});

test("inserting a symbol with a missing package never edits the preamble", () => {
  const preamble = "\\documentclass{article}\n\\begin{document}\n";
  const view = editor(
    `${preamble}$$`,
    EditorSelection.single(preamble.length + 1),
  );
  view.run(insertLatexSymbol(symbol("\\therefore")));
  assert.equal(view.state.doc.toString(), `${preamble}$\\therefore$`);
  assert.equal(
    latexPreamble(view.state.doc.toString()).packages.has("amssymb"),
    false,
  );
});

test("symbol insertion keeps following letters separate and respects multiple carets", () => {
  const view = editor(
    "x y",
    EditorSelection.create([
      EditorSelection.cursor(0),
      EditorSelection.cursor(2),
    ]),
  );
  view.run(insertLatexSymbol(symbol("\\alpha")));
  assert.equal(view.state.doc.toString(), "\\alpha{}x \\alpha{}y");
});

test("package detection handles options, grouped and multiline declarations and dependencies", () => {
  const source =
    "\\documentclass{article}\n\\usepackage[foo]{\n amssymb,\n mathtools\n}\n\\RequirePackage{graphicx}\n\\begin{document}\n";
  const { packages } = latexPreamble(source);
  for (const name of [
    "amssymb",
    "amsfonts",
    "mathtools",
    "amsmath",
    "graphicx",
  ])
    assert.ok(packages.has(name));
  assert.equal(packageInsertion(source, "amsmath"), null);
});

test("comments, escaped commands, verbatim examples and body declarations do not count as loaded packages", () => {
  const source = String.raw`% \usepackage{amssymb}
\\usepackage{amssymb}
\verb|\usepackage{amssymb}|
\documentclass{article}
\begin{document}
\usepackage{amssymb}`;
  assert.equal(latexPreamble(source).packages.has("amssymb"), false);
});

test("explicit package addition follows the existing preamble, retains comments and caret, and is undoable", () => {
  const source =
    "\\documentclass{article} % class\n\\usepackage{graphicx} % figures\n\\begin{document}\n$x$\n\\end{document}";
  const view = editor(
    source,
    EditorSelection.single(source.indexOf("$x$") + 2),
  );
  view.run(addLatexPackage("amssymb"));
  const updated = source.replace(
    "\\begin{document}",
    "\\usepackage{amssymb}\n\\begin{document}",
  );
  assert.equal(view.state.doc.toString(), updated);
  assert.equal(view.state.selection.main.head, updated.indexOf("$x$") + 2);
  assert.equal(view.run(addLatexPackage("amssymb")), false);
  assert.equal(view.state.doc.toString(), updated);
  view.run(undo);
  assert.equal(view.state.doc.toString(), source);
});

test("package insertion remains before the body on a single line and preserves CRLF", () => {
  const view = editor("\\documentclass{article}\\begin{document}$x$");
  view.run(addLatexPackage("amsmath"));
  assert.equal(
    view.state.doc.toString(),
    "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}$x$",
  );
  const source = "\\documentclass{article}\r\n\\begin{document}\r\n";
  const changes = packageInsertion(source, "amssymb");
  assert.ok(changes);
  assert.equal(
    source.slice(0, changes.from) + changes.insert + source.slice(changes.from),
    "\\documentclass{article}\r\n\\usepackage{amssymb}\r\n\\begin{document}\r\n",
  );
});

test("package addition handles an empty document and a preamble with no class declaration", () => {
  const empty = editor("");
  empty.run(addLatexPackage("amssymb"));
  assert.equal(empty.state.doc.toString(), "\\usepackage{amssymb}\n");
  const view = editor("% Notes\n\\begin{document}");
  view.run(addLatexPackage("amssymb"));
  assert.equal(
    view.state.doc.toString(),
    "% Notes\n\\usepackage{amssymb}\n\\begin{document}",
  );
});

test("read-only editors reject both symbol insertion and package addition", () => {
  const view = editor("$x$", EditorSelection.single(1), true);
  assert.equal(view.run(insertLatexSymbol(symbol("\\alpha"))), false);
  assert.equal(view.run(addLatexPackage("amssymb")), false);
  assert.equal(view.state.doc.toString(), "$x$");
});
