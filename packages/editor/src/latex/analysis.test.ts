import assert from "node:assert/strict";
import { test } from "node:test";

import { EditorState } from "@uiw/react-codemirror";

import { analyzeProject, scanFile } from "./analysis";
import { projectDiagnostics } from "./language";

function analyze(files: Record<string, string>) {
  const scanned = new Map(
    Object.entries(files).map(([path, text]) => [path, scanFile(path, text)]),
  );
  return analyzeProject(scanned, Object.keys(files), {});
}

test("warns about duplicate keys across .bib files, without case", () => {
  const { problems, citations } = analyze({
    "main.tex": "\\cite{knuth1984}",
    "a.bib": "@book{knuth1984,\n}\n",
    "b.bib": "\n\n@book{Knuth1984,\n}\n@book{knuth1984,\n}\n",
  });
  assert.deepEqual(citations, ["Knuth1984", "knuth1984"]);
  assert.deepEqual(
    problems
      .filter(({ message }) => message.startsWith("Duplicate"))
      .map(({ path, line, message }) => ({ path, line, message })),
    [
      {
        path: "b.bib",
        line: 3,
        message:
          "Duplicate bibliography key “Knuth1984” (first defined in a.bib, line 1)",
      },
      {
        path: "b.bib",
        line: 5,
        message:
          "Duplicate bibliography key “knuth1984” (first defined in a.bib, line 1)",
      },
    ],
  );
});

test("reports undefined citations with suggestions", () => {
  const { problems } = analyze({
    "main.tex": "See \\cite{knuht1984, lamport1994, missing}.",
    "refs.bib": "@book{knuth1984,\n}\n@book{lamport1994,\n}\n",
  });
  assert.deepEqual(
    problems.map(({ message, citation }) => ({ message, citation })),
    [
      {
        message: "Unknown citation “knuht1984”",
        citation: { key: "knuht1984", suggestions: ["knuth1984"] },
      },
      {
        message: "Unknown citation “missing”",
        citation: { key: "missing", suggestions: [] },
      },
      { message: "Unused bibliography entry “knuth1984”", citation: undefined },
    ],
  );
});

test("offers quick fixes for undefined citations in editable files", () => {
  const doc = "See \\cite{knuht1984}.";
  const { problems } = analyze({
    "main.tex": doc,
    "refs.bib": "@book{knuth1984,\n}\n",
  });
  const added: string[] = [];
  const state = EditorState.create({ doc });
  const [diagnostic] = projectDiagnostics(state, problems, (key) =>
    added.push(key),
  );
  assert.deepEqual(
    diagnostic?.actions?.map(({ name }) => name),
    ["Use “knuth1984”", "Add reference…"],
  );

  let changed = "";
  const view = {
    state,
    dispatch: (spec: Parameters<EditorState["update"]>[0]) => {
      changed = state.update(spec).state.doc.toString();
    },
  };
  const { from, to } = diagnostic ?? { from: 0, to: 0 };
  diagnostic?.actions?.[0]?.apply(view as never, from, to);
  assert.equal(changed, "See \\cite{knuth1984}.");
  diagnostic?.actions?.[1]?.apply(view as never, from, to);
  assert.deepEqual(added, ["knuht1984"]);

  const readOnly = EditorState.create({
    doc,
    extensions: EditorState.readOnly.of(true),
  });
  assert.equal(projectDiagnostics(readOnly, problems)[0]?.actions, undefined);
});
