import assert from "node:assert/strict";
import { test } from "node:test";

import { history, undo } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  type StateCommand,
} from "@codemirror/state";

import { escapeLatexCell, insertLatexTable, tableToLatex } from "./table.js";

function editor(
  doc: string,
  selection = EditorSelection.single(doc.length),
  readOnly = false,
) {
  let state = EditorState.create({
    doc,
    selection,
    extensions: [history(), EditorState.readOnly.of(readOnly)],
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

test("escapes all LaTeX special characters and normalizes internal line breaks", () => {
  assert.equal(
    escapeLatexCell("a & b % $ # _ { } ~ ^ \\"),
    "a \\& b \\% \\$ \\# \\_ \\{ \\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}",
  );
  assert.equal(
    escapeLatexCell("  line 1\r\n  line 2\nline 3  "),
    "line 1 line 2 line 3",
  );
  assert.equal(escapeLatexCell("hello\u00a0world"), "hello world");
});

test("converts Excel-style HTML with style classes, alignment, and bold headers", () => {
  const html = `
    <html>
      <head>
        <style>
          .xl65 { font-weight:700; text-align:center; }
          .xl66 { text-align:right; }
        </style>
      </head>
      <body>
        <table>
          <!--StartFragment-->
          <tr>
            <td class="xl65">Item</td>
            <td class="xl65">Qty</td>
            <td class="xl65">Price</td>
          </tr>
          <tr>
            <td>Widget &amp; Co</td>
            <td class="xl66">10</td>
            <td class="xl66">$4.50</td>
          </tr>
          <tr>
            <td>Gadget</td>
            <td class="xl66">2</td>
            <td class="xl66">$19.99</td>
          </tr>
          <!--EndFragment-->
        </table>
      </body>
    </html>
  `;

  const result = tableToLatex({
    html,
    text: "Item\tQty\tPrice\nWidget & Co\t10\t$4.50\nGadget\t2\t$19.99",
  });
  assert.ok(result);
  assert.equal(result.rows, 3);
  assert.equal(result.columns, 3);
  assert.deepEqual(result.packages, ["booktabs"]);
  assert.equal(
    result.latex,
    [
      "\\begin{tabular}{crr}",
      "  \\toprule",
      "  \\textbf{Item} & \\textbf{Qty} & \\textbf{Price} \\\\",
      "  \\midrule",
      "  Widget \\& Co & 10 & \\$4.50 \\\\",
      "  Gadget & 2 & \\$19.99 \\\\",
      "  \\bottomrule",
      "\\end{tabular}",
    ].join("\n"),
  );
});

test("converts Google Sheets-style HTML with inline styles and entities", () => {
  const html = `<google-sheets-html-origin><style type="text/css">td {border: 1px solid #ccc;}</style><table xmlns="http://www.w3.org/1999/xhtml"><tbody><tr><td style="font-weight:bold;text-align:left;">Metric</td><td style="font-weight:bold;text-align:right;">Score (%)</td></tr><tr><td>Accuracy_1</td><td>98.5%</td></tr><tr><td>F1^2<br>weighted</td><td>97.1%</td></tr></tbody></table></google-sheets-html-origin>`;

  const result = tableToLatex({ html });
  assert.ok(result);
  assert.equal(result.rows, 3);
  assert.equal(result.columns, 2);
  assert.deepEqual(result.packages, ["booktabs"]);
  assert.equal(
    result.latex,
    [
      "\\begin{tabular}{lr}",
      "  \\toprule",
      "  \\textbf{Metric} & \\textbf{Score (\\%)} \\\\",
      "  \\midrule",
      "  Accuracy\\_1 & 98.5\\% \\\\",
      "  F1\\textasciicircum{}2 weighted & 97.1\\% \\\\",
      "  \\bottomrule",
      "\\end{tabular}",
    ].join("\n"),
  );
});

test("converts bare TSV with numeric right-alignment and quoted multiline cells", () => {
  const tsv =
    'Name\tNotes\tAmount\r\nAlice\t"First line\nSecond line"\t1,200\r\nBob\t50% off\t-35.5\r\n';
  const result = tableToLatex({ text: tsv });
  assert.ok(result);
  assert.equal(result.rows, 3);
  assert.equal(result.columns, 3);
  assert.deepEqual(result.packages, ["booktabs"]);
  assert.equal(
    result.latex,
    [
      "\\begin{tabular}{llr}",
      "  \\toprule",
      "  Name & Notes & Amount \\\\",
      "  \\midrule",
      "  Alice & First line Second line & 1,200 \\\\",
      "  Bob & 50\\% off & -35.5 \\\\",
      "  \\bottomrule",
      "\\end{tabular}",
    ].join("\n"),
  );
});

test("handles merged cells (colspan, rowspan, and combined) and reports multirow package", () => {
  const html = `
    <table>
      <thead>
        <tr>
          <th rowspan="2">Region</th>
          <th colspan="2" align="center">Sales</th>
        </tr>
        <tr>
          <th>Q1</th>
          <th>Q2</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td rowspan="2">North</td>
          <td>100</td>
          <td>120</td>
        </tr>
        <tr>
          <td>110</td>
          <td>130</td>
        </tr>
      </tbody>
    </table>
  `;

  const result = tableToLatex({ html });
  assert.ok(result);
  assert.equal(result.rows, 4);
  assert.equal(result.columns, 3);
  assert.deepEqual(result.packages, ["booktabs", "multirow"]);
  assert.equal(
    result.latex,
    [
      "\\begin{tabular}{lrr}",
      "  \\toprule",
      "  \\multirow{2}{*}{\\textbf{Region}} & \\multicolumn{2}{c}{\\textbf{Sales}} \\\\",
      "   & \\textbf{Q1} & \\textbf{Q2} \\\\",
      "  \\midrule",
      "  \\multirow{2}{*}{North} & 100 & 120 \\\\",
      "   & 110 & 130 \\\\",
      "  \\bottomrule",
      "\\end{tabular}",
    ].join("\n"),
  );
});

test("handles combined colspan and rowspan with covered placeholder multicolumn", () => {
  const html = `
    <table>
      <tr><td colspan="2" rowspan="2" align="center">Block</td><td>1</td></tr>
      <tr><td>2</td></tr>
      <tr><td>A</td><td>B</td><td>3</td></tr>
    </table>
  `;
  const result = tableToLatex({ html });
  assert.ok(result);
  assert.deepEqual(result.packages, ["booktabs", "multirow"]);
  assert.equal(
    result.latex,
    [
      "\\begin{tabular}{llr}",
      "  \\toprule",
      "  \\multicolumn{2}{c}{\\multirow{2}{*}{Block}} & 1 \\\\",
      "  \\multicolumn{2}{c}{} & 2 \\\\",
      "  A & B & 3 \\\\",
      "  \\bottomrule",
      "\\end{tabular}",
    ].join("\n"),
  );
});

test("handles empty cells and ragged TSV rows cleanly", () => {
  const result = tableToLatex({ text: "A\tB\tC\n1\t\t3\n\t2\n" });
  assert.ok(result);
  assert.equal(result.rows, 3);
  assert.equal(result.columns, 3);
  assert.equal(
    result.latex,
    [
      "\\begin{tabular}{rrr}",
      "  \\toprule",
      "  A & B & C \\\\",
      "  \\midrule",
      "  1 &  & 3 \\\\",
      "   & 2 &  \\\\",
      "  \\bottomrule",
      "\\end{tabular}",
    ].join("\n"),
  );
});

test("supports hline rule style without requiring booktabs", () => {
  const result = tableToLatex({ text: "X\tY\n1\t2" }, { rules: "hline" });
  assert.ok(result);
  assert.deepEqual(result.packages, []);
  assert.equal(
    result.latex,
    [
      "\\begin{tabular}{rr}",
      "  \\hline",
      "  X & Y \\\\",
      "  \\hline",
      "  1 & 2 \\\\",
      "  \\hline",
      "\\end{tabular}",
    ].join("\n"),
  );
});

test("returns null for single cells, single lines, plain prose, and tab-indented code", () => {
  assert.equal(tableToLatex({ text: "just one cell" }), null);
  assert.equal(tableToLatex({ text: "a\tb\tc" }), null);
  assert.equal(tableToLatex({ text: "line 1\nline 2\nline 3" }), null);
  assert.equal(tableToLatex({ text: "\tconst a = 1;\n\tconst b = 2;" }), null);
  assert.equal(
    tableToLatex({ html: "<table><tr><td>only cell</td></tr></table>" }),
    null,
  );
  assert.equal(
    tableToLatex({ html: "<table><tr><td>a</td><td>b</td></tr></table>" }),
    null,
  );
  assert.equal(
    tableToLatex({ html: "<p>Not a table</p>", text: "Not a table" }),
    null,
  );
});

test("insertLatexTable inserts in one undoable transaction and respects line indentation and readOnly", () => {
  const result = tableToLatex({ text: "A\tB\n1\t2" });
  assert.ok(result);

  const view = editor(
    "\\begin{center}\n  \n\\end{center}",
    EditorSelection.single(17),
  );
  assert.equal(view.run(insertLatexTable(result.latex)), true);
  assert.equal(
    view.state.doc.toString(),
    [
      "\\begin{center}",
      "  \\begin{tabular}{rr}",
      "    \\toprule",
      "    A & B \\\\",
      "    \\midrule",
      "    1 & 2 \\\\",
      "    \\bottomrule",
      "  \\end{tabular}",
      "\\end{center}",
    ].join("\n"),
  );

  // One undo step restores the exact state before the paste.
  view.run(undo);
  assert.equal(view.state.doc.toString(), "\\begin{center}\n  \n\\end{center}");

  const ro = editor("hello", EditorSelection.single(5), true);
  assert.equal(ro.run(insertLatexTable(result.latex)), false);
  assert.equal(ro.state.doc.toString(), "hello");
});
