import {
  delimitedIndent,
  foldInside,
  foldNodeProp,
  indentNodeProp,
  type Language,
  LanguageDescription,
  LanguageSupport,
  LRLanguage,
} from "@codemirror/language";
import { linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import {
  type Input,
  type Parser,
  parseMixed,
  type SyntaxNodeRef,
} from "@lezer/common";

import { latexCompletionSource } from "./completion.js";
import { latexLinter, type LatexLinterOptions } from "./lint.js";
import { parser } from "./parser.js";

/**
 * Lezer-based `LRLanguage` for LaTeX documents, configured with syntax
 * highlighting tags, indentation, folding, and comment/bracket metadata.
 */
export const latexLanguage = LRLanguage.define({
  name: "latex",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        Environment: (context) => {
          const isEnd = /^\s*\\end\b/.test(context.textAfter);
          return context.baseIndent + (isEnd ? 0 : context.unit);
        },
        MathEnvironment: (context) => {
          const isEnd = /^\s*\\end\b/.test(context.textAfter);
          return context.baseIndent + (isEnd ? 0 : context.unit);
        },
        BracedGroup: delimitedIndent({ closing: "}" }),
        OptionalArgument: delimitedIndent({ closing: "]" }),
      }),
      foldNodeProp.add({
        Environment: foldEnvironment,
        MathEnvironment: foldEnvironment,
        VerbatimEnvironment: foldEnvironment,
        BracedGroup: foldInside,
      }),
    ],
  }),
  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["(", "[", "{", "$"] },
    indentOnInput: /^\s*(?:\\end\b|[}\]])/,
  },
});

function foldEnvironment(tree: {
  firstChild: { to: number } | null;
  lastChild: { from: number } | null;
}) {
  const begin = tree.firstChild;
  const end = tree.lastChild;
  if (!begin || !end || begin.to >= end.from) return null;
  return { from: begin.to, to: end.from };
}

export type CodeLanguageResolver =
  | readonly LanguageDescription[]
  | ((info: string) => Language | Parser | null);

export type LatexConfig = {
  /** Enable built-in LaTeX command & environment autocompletion. Default: `true`. */
  enableAutocomplete?: boolean;
  /** Enable built-in LaTeX syntax linting. Default: `false`. */
  enableLinting?: boolean;
  /** Options forwarded to `latexLinter` when `enableLinting` is `true`. */
  linterOptions?: LatexLinterOptions;
  /**
   * Optional nested language resolver for `minted` and `lstlisting` code
   * environments, powered by Lezer `parseMixed`.
   */
  codeLanguages?: CodeLanguageResolver;
};

function resolveCodeParser(
  resolver: CodeLanguageResolver,
  info: string,
): Parser | null {
  if (typeof resolver === "function") {
    const found = resolver(info);
    if (!found) return null;
    return "parser" in found ? found.parser : found;
  }
  const desc = LanguageDescription.matchLanguageName(resolver, info, true);
  return desc?.support?.language.parser ?? null;
}

function extractCodeOverlay(
  envName: string,
  node: SyntaxNodeRef,
  input: Input,
): { info: string; from: number; to: number } | null {
  const text = input.read(node.from, Math.min(node.to, node.from + 256));
  if (envName === "minted") {
    const match = /^(?:\s*\[[^\]]*\])*\s*\{([^}\n]+)\}/.exec(text);
    if (!match) return null;
    const from = node.from + match[0].length;
    return from < node.to
      ? { info: match[1]!.trim(), from, to: node.to }
      : null;
  }
  if (envName === "lstlisting") {
    const match = /^\s*\[([^\]]*)\]/.exec(text);
    if (!match) return null;
    const langMatch = /\blanguage\s*=\s*(?:\{([^}]+)\}|([^,\]]+))/i.exec(
      match[1]!,
    );
    if (!langMatch) return null;
    const info = (langMatch[1] ?? langMatch[2] ?? "").trim();
    const from = node.from + match[0].length;
    return info && from < node.to ? { info, from, to: node.to } : null;
  }
  return null;
}

function withCodeLanguages(resolver: CodeLanguageResolver): LRLanguage {
  return LRLanguage.define({
    name: latexLanguage.name,
    parser: latexLanguage.parser.configure({
      wrap: parseMixed((node, input) => {
        if (node.name !== "VerbatimContent") return null;
        const parent = node.node.parent;
        if (!parent || parent.name !== "VerbatimEnvironment") return null;
        const begin = parent.getChild("BeginVerbatimEnv");
        const envNameNode = begin?.getChild("EnvName");
        if (!envNameNode) return null;
        const envName = input.read(envNameNode.from, envNameNode.to).trim();
        const overlay = extractCodeOverlay(envName, node, input);
        if (!overlay) return null;
        const innerParser = resolveCodeParser(resolver, overlay.info);
        if (!innerParser) return null;
        return {
          parser: innerParser,
          overlay: [{ from: overlay.from, to: overlay.to }],
        };
      }),
    }),
    languageData: {
      commentTokens: { line: "%" },
      closeBrackets: { brackets: ["(", "[", "{", "$"] },
      indentOnInput: /^\s*(?:\\end\b|[}\]])/,
    },
  });
}

/**
 * CodeMirror 6 language support for LaTeX.
 */
export function latex(config: LatexConfig = {}): LanguageSupport {
  const {
    enableAutocomplete = true,
    enableLinting = false,
    linterOptions,
    codeLanguages,
  } = config;
  const language = codeLanguages
    ? withCodeLanguages(codeLanguages)
    : latexLanguage;
  const support: Extension[] = [];
  if (enableAutocomplete) {
    support.push(language.data.of({ autocomplete: latexCompletionSource }));
  }
  if (enableLinting) {
    support.push(linter(latexLinter(linterOptions)));
  }
  return new LanguageSupport(language, support);
}
