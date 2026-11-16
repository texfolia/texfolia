import { expect, test } from "bun:test";

import { projectOutline } from "./outline";

test("outline follows includes at their document position and nests headings across files", () => {
  const tree = projectOutline(
    new Map([
      [
        "main.tex",
        "\\part{A}\n\\section{First}\n\\input{chapters/intro}\n\\section*{Last}",
      ],
      [
        "chapters/intro.tex",
        "\\subsection[Short]{Long \\textbf{heading}}\n\\include{nested}\n\\input{main}",
      ],
      ["chapters/nested.tex", "\\subsubsection{Nested}"],
    ]),
    "main.tex",
  );
  expect(tree[0]?.title).toBe("A");
  expect(tree[0]?.children.map((entry) => entry.title)).toEqual([
    "First",
    "Last",
  ]);
  expect(tree[0]?.children[0]?.children[0]).toMatchObject({
    path: "chapters/intro.tex",
    line: 1,
    title: "Short",
    children: [{ path: "chapters/nested.tex", line: 1, title: "Nested" }],
  });
});

test("outline ignores comments and verbatim material while retaining heading line numbers", () => {
  const text =
    "% \\section{Comment}\n\\begin{verbatim}\n\\section{Code}\n\\end{verbatim}\n\\section{Real {nested} heading}\n\\input missing\n\\subsection{Child}";
  const tree = projectOutline(new Map([["main.tex", text]]), "main.tex");
  expect(tree).toHaveLength(1);
  expect(tree[0]).toMatchObject({
    title: "Real nested heading",
    line: 5,
    children: [{ title: "Child", line: 7 }],
  });
});

test("unbraced input and repeated includes retain document order without recursive cycles", () => {
  const tree = projectOutline(
    new Map([
      ["main.tex", "\\input intro\n\\input{intro}"],
      ["intro.tex", "\\section{Introduction}\n\\input{main}"],
    ]),
    "main.tex",
  );
  expect(tree.map((entry) => entry.title)).toEqual([
    "Introduction",
    "Introduction",
  ]);
  expect(projectOutline(new Map(), undefined)).toEqual([]);
});
