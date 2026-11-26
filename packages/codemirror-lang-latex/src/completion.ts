import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { indentUnit } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const ENVIRONMENTS: readonly string[] = [
  "abstract",
  "align",
  "align*",
  "aligned",
  "array",
  "bmatrix",
  "cases",
  "center",
  "corollary",
  "definition",
  "description",
  "document",
  "enumerate",
  "equation",
  "equation*",
  "example",
  "figure",
  "figure*",
  "flushleft",
  "flushright",
  "frame",
  "gather",
  "gather*",
  "itemize",
  "lemma",
  "lstlisting",
  "matrix",
  "minipage",
  "minted",
  "multline",
  "multline*",
  "pmatrix",
  "proof",
  "proposition",
  "quotation",
  "quote",
  "remark",
  "split",
  "subfigure",
  "table",
  "table*",
  "tabular",
  "tabularx",
  "theorem",
  "tikzpicture",
  "verbatim",
  "vmatrix",
];

type CommandDef = {
  label: string;
  /** Number of braced arguments; cursor is placed inside the first `{}`. */
  args?: number;
  detail?: string;
};

const COMMANDS: readonly CommandDef[] = [
  // Document structure
  { label: "\\documentclass", args: 1, detail: "Document class" },
  { label: "\\usepackage", args: 1, detail: "Load package" },
  { label: "\\title", args: 1, detail: "Document title" },
  { label: "\\author", args: 1, detail: "Document author" },
  { label: "\\date", args: 1, detail: "Document date" },
  { label: "\\maketitle", detail: "Render title" },
  { label: "\\tableofcontents", detail: "Table of contents" },
  { label: "\\part", args: 1, detail: "Part heading" },
  { label: "\\chapter", args: 1, detail: "Chapter heading" },
  { label: "\\section", args: 1, detail: "Section heading" },
  { label: "\\section*", args: 1, detail: "Unnumbered section" },
  { label: "\\subsection", args: 1, detail: "Subsection heading" },
  { label: "\\subsection*", args: 1, detail: "Unnumbered subsection" },
  { label: "\\subsubsection", args: 1, detail: "Subsubsection heading" },
  { label: "\\paragraph", args: 1, detail: "Paragraph heading" },
  { label: "\\subparagraph", args: 1, detail: "Subparagraph heading" },
  { label: "\\appendix", detail: "Start appendices" },
  // Environments & files
  { label: "\\begin", args: 1, detail: "Begin environment" },
  { label: "\\end", args: 1, detail: "End environment" },
  { label: "\\input", args: 1, detail: "Input TeX file" },
  { label: "\\include", args: 1, detail: "Include TeX file" },
  { label: "\\includegraphics", args: 1, detail: "Insert image" },
  { label: "\\bibliography", args: 1, detail: "BibTeX bibliography" },
  { label: "\\bibliographystyle", args: 1, detail: "BibTeX style" },
  { label: "\\addbibresource", args: 1, detail: "BibLaTeX resource" },
  { label: "\\printbibliography", detail: "Print bibliography" },
  // References & citations
  { label: "\\label", args: 1, detail: "Define label" },
  { label: "\\ref", args: 1, detail: "Cross-reference" },
  { label: "\\eqref", args: 1, detail: "Equation reference" },
  { label: "\\pageref", args: 1, detail: "Page reference" },
  { label: "\\autoref", args: 1, detail: "Named reference" },
  { label: "\\cref", args: 1, detail: "Clever reference" },
  { label: "\\cite", args: 1, detail: "Citation" },
  { label: "\\citep", args: 1, detail: "Parenthetical citation" },
  { label: "\\citet", args: 1, detail: "Textual citation" },
  { label: "\\nocite", args: 1, detail: "Uncited entry" },
  // Text formatting
  { label: "\\textbf", args: 1, detail: "Bold text" },
  { label: "\\textit", args: 1, detail: "Italic text" },
  { label: "\\emph", args: 1, detail: "Emphasized text" },
  { label: "\\underline", args: 1, detail: "Underlined text" },
  { label: "\\texttt", args: 1, detail: "Monospace text" },
  { label: "\\textsc", args: 1, detail: "Small caps" },
  { label: "\\textsf", args: 1, detail: "Sans-serif text" },
  { label: "\\textrm", args: 1, detail: "Roman text" },
  { label: "\\text", args: 1, detail: "Text in math mode" },
  { label: "\\footnote", args: 1, detail: "Footnote" },
  { label: "\\caption", args: 1, detail: "Float caption" },
  { label: "\\centering", detail: "Center float contents" },
  { label: "\\item", detail: "List item" },
  { label: "\\newline", detail: "Line break" },
  { label: "\\newpage", detail: "Page break" },
  { label: "\\clearpage", detail: "Flush floats and break page" },
  { label: "\\hline", detail: "Horizontal table rule" },
  { label: "\\toprule", detail: "Booktabs top rule" },
  { label: "\\midrule", detail: "Booktabs mid rule" },
  { label: "\\bottomrule", detail: "Booktabs bottom rule" },
  { label: "\\url", args: 1, detail: "URL" },
  { label: "\\href", args: 2, detail: "Hyperlink" },
  // Math
  { label: "\\frac", args: 2, detail: "Fraction" },
  { label: "\\dfrac", args: 2, detail: "Display fraction" },
  { label: "\\tfrac", args: 2, detail: "Text fraction" },
  { label: "\\sqrt", args: 1, detail: "Square root" },
  { label: "\\sum", detail: "Summation" },
  { label: "\\prod", detail: "Product" },
  { label: "\\int", detail: "Integral" },
  { label: "\\lim", detail: "Limit" },
  { label: "\\infty", detail: "Infinity" },
  { label: "\\partial", detail: "Partial derivative" },
  { label: "\\nabla", detail: "Nabla" },
  { label: "\\mathbb", args: 1, detail: "Blackboard bold" },
  { label: "\\mathcal", args: 1, detail: "Calligraphic" },
  { label: "\\mathbf", args: 1, detail: "Bold math" },
  { label: "\\mathrm", args: 1, detail: "Roman math" },
  { label: "\\hat", args: 1, detail: "Hat accent" },
  { label: "\\bar", args: 1, detail: "Bar accent" },
  { label: "\\vec", args: 1, detail: "Vector accent" },
  { label: "\\tilde", args: 1, detail: "Tilde accent" },
  { label: "\\overline", args: 1, detail: "Overline" },
  { label: "\\left", detail: "Left scalable delimiter" },
  { label: "\\right", detail: "Right scalable delimiter" },
  { label: "\\cdot", detail: "Centered dot" },
  { label: "\\times", detail: "Times" },
  { label: "\\pm", detail: "Plus-minus" },
  { label: "\\leq", detail: "Less than or equal" },
  { label: "\\geq", detail: "Greater than or equal" },
  { label: "\\neq", detail: "Not equal" },
  { label: "\\approx", detail: "Approximately equal" },
  { label: "\\equiv", detail: "Equivalent" },
  { label: "\\in", detail: "Element of" },
  { label: "\\subset", detail: "Subset" },
  { label: "\\subseteq", detail: "Subset or equal" },
  { label: "\\cup", detail: "Union" },
  { label: "\\cap", detail: "Intersection" },
  { label: "\\forall", detail: "For all" },
  { label: "\\exists", detail: "Exists" },
  { label: "\\rightarrow", detail: "Right arrow" },
  { label: "\\Rightarrow", detail: "Implies" },
  { label: "\\leftrightarrow", detail: "Left-right arrow" },
  { label: "\\Leftrightarrow", detail: "If and only if" },
  // Greek letters
  { label: "\\alpha" },
  { label: "\\beta" },
  { label: "\\gamma" },
  { label: "\\delta" },
  { label: "\\epsilon" },
  { label: "\\varepsilon" },
  { label: "\\zeta" },
  { label: "\\eta" },
  { label: "\\theta" },
  { label: "\\iota" },
  { label: "\\kappa" },
  { label: "\\lambda" },
  { label: "\\mu" },
  { label: "\\nu" },
  { label: "\\xi" },
  { label: "\\pi" },
  { label: "\\rho" },
  { label: "\\sigma" },
  { label: "\\tau" },
  { label: "\\upsilon" },
  { label: "\\phi" },
  { label: "\\varphi" },
  { label: "\\chi" },
  { label: "\\psi" },
  { label: "\\omega" },
  { label: "\\Gamma" },
  { label: "\\Delta" },
  { label: "\\Theta" },
  { label: "\\Lambda" },
  { label: "\\Xi" },
  { label: "\\Pi" },
  { label: "\\Sigma" },
  { label: "\\Phi" },
  { label: "\\Psi" },
  { label: "\\Omega" },
  // Macros
  { label: "\\newcommand", args: 2, detail: "Define command" },
  { label: "\\renewcommand", args: 2, detail: "Redefine command" },
  { label: "\\DeclareMathOperator", args: 2, detail: "Define math operator" },
];

function applyBeginEnvironment(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
) {
  const name = completion.label;
  const line = view.state.doc.lineAt(from);
  const baseIndent = /^\s*/.exec(line.text)?.[0] ?? "";
  const unit = view.state.facet(indentUnit) || "  ";
  const bodyIndent = baseIndent + unit;
  // Consume an immediately following auto-closed `}` so we don't leave `}}`.
  const hasClosingBrace = view.state.sliceDoc(to, to + 1) === "}";
  const replaceTo = hasClosingBrace ? to + 1 : to;
  const insert = `${name}}\n${bodyIndent}\n${baseIndent}\\end{${name}}`;
  const cursor = from + name.length + 2 + bodyIndent.length;
  view.dispatch({
    changes: { from, to: replaceTo, insert },
    selection: EditorSelection.cursor(cursor),
    userEvent: "input.complete",
  });
}

function applyCommand(def: CommandDef) {
  if (!def.args) return def.label;
  return (
    view: EditorView,
    _completion: Completion,
    from: number,
    to: number,
  ) => {
    const braces = "{}".repeat(def.args ?? 1);
    const insert = `${def.label}${braces}`;
    const cursor = from + def.label.length + 1;
    view.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.cursor(cursor),
      userEvent: "input.complete",
    });
  };
}

const commandOptions: readonly Completion[] = COMMANDS.map((def) => ({
  label: def.label,
  type: "keyword",
  detail: def.detail,
  apply: applyCommand(def),
}));

const beginEnvOptions: readonly Completion[] = ENVIRONMENTS.map((name) => ({
  label: name,
  type: "class",
  apply: applyBeginEnvironment,
}));

const endEnvOptions: readonly Completion[] = ENVIRONMENTS.map((name) => ({
  label: name,
  type: "class",
}));

/**
 * Clean-room CodeMirror completion source for standard LaTeX commands and
 * `\begin{...}` / `\end{...}` environments.
 */
export const latexCompletionSource: CompletionSource = (
  context: CompletionContext,
): CompletionResult | null => {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.sliceDoc(
    Math.max(line.from, context.pos - 200),
    context.pos,
  );
  // Do not complete inside comments.
  if (/(?:^|[^\\])(?:\\\\)*%/.test(before)) return null;

  // Complete environment names in `\begin{...}` and `\end{...}`.
  const envMatch = /\\(begin|end)\{([a-zA-Z*]*)$/.exec(before);
  if (envMatch) {
    const kind = envMatch[1];
    const prefix = envMatch[2] ?? "";
    const from = context.pos - prefix.length;
    const options = kind === "begin" ? beginEnvOptions : endEnvOptions;
    const filtered = prefix
      ? options.filter((option) => option.label.startsWith(prefix))
      : options;
    if (!filtered.length) return null;
    return { from, options: filtered, validFor: /^[a-zA-Z*]*$/ };
  }

  // Complete LaTeX commands starting with `\`.
  const cmdMatch = /(?:^|[^\\])(?:\\\\)*(\\[a-zA-Z*]+)$/.exec(before);
  if (cmdMatch) {
    const prefix = cmdMatch[1] ?? "";
    if (prefix.length < 2 && !context.explicit) return null;
    const from = context.pos - prefix.length;
    return {
      from,
      options: commandOptions,
      validFor: /^\\[a-zA-Z*]*$/,
    };
  }

  return null;
};
