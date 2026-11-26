import {
  delimitedIndent,
  foldInside,
  foldNodeProp,
  indentNodeProp,
  LanguageSupport,
  LRLanguage,
} from "@codemirror/language";
import { linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { styleTags, tags } from "@lezer/highlight";

import { latexCompletionSource } from "./completion.js";
import { latexLinter, type LatexLinterOptions } from "./lint.js";
import { parser } from "./parser.js";
import { latexTags } from "./tags.js";

export { bibtexLanguage } from "./bibtex.js";
export { latexCompletionSource } from "./completion.js";
export { latexLinter, type LatexLinterOptions } from "./lint.js";
export { latexTags } from "./tags.js";

/**
 * Clean-room Lezer-based `LRLanguage` for LaTeX documents, configured with
 * syntax highlighting tags, indentation, folding, and comment/bracket metadata.
 */
export const latexLanguage = LRLanguage.define({
  name: "latex",
  parser: parser.configure({
    props: [
      styleTags({
        "CommandName BeginCommand EndCommand": latexTags.command,
        "EnvName/...": latexTags.environment,
        "InlineMath/... DisplayMath/...": latexTags.math,
        "BracedGroup/...": latexTags.argument,
        "OptionalArgument/...": latexTags.option,
        Comment: tags.comment,
        EscapedChar: tags.escape,
        Number: tags.number,
        MathOperator: tags.operator,
        "{ }": tags.brace,
        "[ ]": tags.squareBracket,
      }),
      indentNodeProp.add({
        Environment: (context) => {
          const isEnd = /^\s*\\end\b/.test(context.textAfter);
          return context.baseIndent + (isEnd ? 0 : context.unit);
        },
        BracedGroup: delimitedIndent({ closing: "}" }),
        OptionalArgument: delimitedIndent({ closing: "]" }),
      }),
      foldNodeProp.add({
        Environment(tree) {
          const begin = tree.firstChild;
          const end = tree.lastChild;
          if (!begin || !end || begin.to >= end.from) return null;
          return { from: begin.to, to: end.from };
        },
        BracedGroup: foldInside,
      }),
    ],
  }),
  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["(", "[", "{", "$"] },
  },
});

export type LatexConfig = {
  /** Enable built-in LaTeX command & environment autocompletion. Default: `true`. */
  enableAutocomplete?: boolean;
  /** Enable built-in LaTeX syntax linting. Default: `false`. */
  enableLinting?: boolean;
  /** Options forwarded to `latexLinter` when `enableLinting` is `true`. */
  linterOptions?: LatexLinterOptions;
};

/**
 * CodeMirror 6 language support for LaTeX.
 */
export function latex(config: LatexConfig = {}): LanguageSupport {
  const {
    enableAutocomplete = true,
    enableLinting = false,
    linterOptions,
  } = config;
  const support: Extension[] = [];
  if (enableAutocomplete) {
    support.push(
      latexLanguage.data.of({ autocomplete: latexCompletionSource }),
    );
  }
  if (enableLinting) {
    support.push(linter(latexLinter(linterOptions)));
  }
  return new LanguageSupport(latexLanguage, support);
}
