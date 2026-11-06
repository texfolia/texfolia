import {
  type Completion,
  type CompletionSource,
  snippetCompletion,
} from "@codemirror/autocomplete";

import { isIncludePath, type LatexAnalysis } from "./analysis";

const environments = [
  "align",
  "align*",
  "array",
  "center",
  "description",
  "document",
  "enumerate",
  "equation",
  "equation*",
  "figure",
  "gather",
  "itemize",
  "minipage",
  "pmatrix",
  "quote",
  "table",
  "tabular",
  "theorem",
  "verbatim",
];

const coreCommands = [
  "author",
  "begin",
  "bibliography",
  "caption",
  "chapter",
  "cite",
  "documentclass",
  "emph",
  "end",
  "eqref",
  "frac",
  "include",
  "includegraphics",
  "input",
  "item",
  "label",
  "left",
  "maketitle",
  "newcommand",
  "newpage",
  "pageref",
  "paragraph",
  "ref",
  "renewcommand",
  "right",
  "section",
  "sqrt",
  "subsection",
  "sum",
  "tableofcontents",
  "textbf",
  "textit",
  "title",
  "usepackage",
].map((name) => "\\" + name);

const snippets = [
  snippetCompletion("\\begin{${environment}}\n\t${}\n\\end{${environment}}", {
    label: "\\begin…\\end",
    type: "text",
    detail: "environment snippet",
  }),
  snippetCompletion("\\frac{${numerator}}{${denominator}}", {
    label: "\\frac{}",
    type: "text",
    detail: "fraction snippet",
  }),
  snippetCompletion("\\section{${title}}", {
    label: "\\section{}",
    type: "text",
    detail: "section snippet",
  }),
];

function prefixed(
  values: readonly string[],
  prefix: string,
  type: string,
): Completion[] {
  let start = 0;
  let end = values.length;
  while (start < end) {
    const mid = (start + end) >>> 1;
    if ((values[mid] ?? "") < prefix) start = mid + 1;
    else end = mid;
  }
  const options: Completion[] = [];
  for (let i = start; i < values.length && options.length < 100; i++) {
    const label = values[i];
    if (!label?.startsWith(prefix)) break;
    options.push({ label, type });
  }
  return options;
}

export function latexCompletion(
  getAnalysis: () => LatexAnalysis,
  paths: readonly string[],
): CompletionSource {
  const fileOptions = new Map(
    ["input", "include", "includegraphics"].map((command) => [
      command,
      paths.filter((path) => isIncludePath(command, path)).sort(),
    ]),
  );
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(
      Math.max(line.from, context.pos - 250),
      context.pos,
    );
    if (/(?:^|[^\\])(?:\\\\)*%/.test(before)) return null;
    const environment = /\\begin\s*\{([^{}\s]*)(\}?)$/.exec(before);
    if (environment) {
      const prefix = environment[1] ?? "";
      const closingBrace = environment[2] ?? "";
      const options = prefixed(environments, prefix, "type").map((option) =>
        snippetCompletion(
          `${option.label}}\n\t\${}\n\\end{${option.label}}`,
          option,
        ),
      );
      return options.length
        ? {
            from: context.pos - prefix.length - closingBrace.length,
            filter: false,
            to:
              !closingBrace &&
              context.state.sliceDoc(context.pos, context.pos + 1) === "}"
                ? context.pos + 1
                : context.pos,
            options,
          }
        : null;
    }
    const argument =
      /\\([a-z]+)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{(?:[^{}]*,\s*)?([^{}\s,]*)$/i.exec(
        before,
      );
    const [, argumentCommand, prefix] = argument ?? [];
    if (argumentCommand && prefix !== undefined) {
      const command = argumentCommand;
      const analysis = getAnalysis();
      const options =
        command === "end"
          ? prefixed(environments, prefix, "type")
          : /^(?:[a-z]*cite[a-z]*|nocite)$/i.test(command)
            ? prefixed(analysis.citations, prefix, "constant")
            : /^(?:ref|eqref|autoref|pageref|cref)$/i.test(command)
              ? prefixed(analysis.labels, prefix, "reference")
              : prefixed(fileOptions.get(command) ?? [], prefix, "file");
      return options.length
        ? { from: context.pos - prefix.length, options }
        : null;
    }

    const command = /(?:^|[^\\])(?:\\\\)*(\\[a-zA-Z]*)$/.exec(before)?.[1];
    if (!command) return null;
    const commands = [
      ...new Set([...coreCommands, ...getAnalysis().commands]),
    ].sort();
    return {
      from: context.pos - command.length,
      options: [
        ...prefixed(commands, command, "function"),
        ...snippets.filter(({ label }) => label.startsWith(command)),
      ],
    };
  };
}
