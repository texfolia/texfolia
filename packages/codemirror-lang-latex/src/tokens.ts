import { ContextTracker, ExternalTokenizer, type InputStream } from "@lezer/lr";

import {
  BeginCommand,
  BeginEnv,
  BeginMathCommand,
  BeginMathEnv,
  BeginVerbatimCommand,
  BeginVerbatimEnv,
  EndEnv,
  ImplicitEnd,
  InlineVerbatim,
  VerbatimContent,
} from "./parser.terms.js";

export const VERBATIM_ENVS: ReadonlySet<string> = new Set([
  "verbatim",
  "verbatim*",
  "lstlisting",
  "minted",
  "Verbatim",
  "BVerbatim",
  "LVerbatim",
  "alltt",
  "comment",
]);

export const MATH_ENVS: ReadonlySet<string> = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "aligned",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "flalign",
  "flalign*",
  "alignat",
  "alignat*",
  "eqnarray",
  "eqnarray*",
  "math",
  "displaymath",
  "split",
  "cases",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "array",
]);

export type EnvKind = "normal" | "math" | "verbatim";

export class EnvContext {
  readonly hash: number;

  constructor(
    readonly name: string,
    readonly kind: EnvKind,
    readonly parent: EnvContext | null,
  ) {
    let h = parent ? parent.hash : 0;
    for (let i = 0; i < name.length; i++) {
      h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    }
    this.hash =
      ((h << 2) ^ (kind === "verbatim" ? 1 : kind === "math" ? 2 : 3)) | 0;
  }
}

const BACKSLASH = 92;
const LBRACE = 123;
const RBRACE = 125;
const STAR = 42;
const SPACE = 32;
const TAB = 9;
const LF = 10;
const CR = 13;
const AT = 64;

function isAsciiLetterOrAt(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === AT;
}

function matchesLiteral(
  input: InputStream,
  offset: number,
  literal: string,
): boolean {
  for (let i = 0; i < literal.length; i++) {
    if (input.peek(offset + i) !== literal.charCodeAt(i)) return false;
  }
  return true;
}

function peekBracedEnvName(input: InputStream, offset: number): string | null {
  let i = offset;
  while (input.peek(i) === SPACE || input.peek(i) === TAB) i++;
  if (input.peek(i) !== LBRACE) return null;
  i++;
  let name = "";
  for (;;) {
    const ch = input.peek(i);
    if (ch === -1 || ch === LF || ch === CR) return null;
    if (ch === RBRACE) return name.trim();
    name += String.fromCharCode(ch);
    i++;
  }
}

export const inlineVerbatim = new ExternalTokenizer((input) => {
  if (!matchesLiteral(input, 0, "\\verb")) return;
  let offset = 5;
  if (input.peek(offset) === STAR) offset++;
  const delim = input.peek(offset);
  if (
    delim === -1 ||
    delim === SPACE ||
    delim === TAB ||
    delim === LF ||
    delim === CR ||
    isAsciiLetterOrAt(delim)
  ) {
    return;
  }
  input.advance(offset + 1);
  for (;;) {
    const ch = input.next;
    if (ch === -1 || ch === LF || ch === CR) {
      input.acceptToken(InlineVerbatim);
      return;
    }
    input.advance();
    if (ch === delim) {
      input.acceptToken(InlineVerbatim);
      return;
    }
  }
});

export const beginCommand = new ExternalTokenizer((input) => {
  if (!matchesLiteral(input, 0, "\\begin")) return;
  if (isAsciiLetterOrAt(input.peek(6))) return;
  const envName = peekBracedEnvName(input, 6);
  input.advance(6);
  if (envName && VERBATIM_ENVS.has(envName)) {
    input.acceptToken(BeginVerbatimCommand);
  } else if (envName && MATH_ENVS.has(envName)) {
    input.acceptToken(BeginMathCommand);
  } else {
    input.acceptToken(BeginCommand);
  }
});

export const verbatimContent = new ExternalTokenizer(
  (input, stack) => {
    const ctx = stack.context as EnvContext | null;
    if (!ctx || ctx.kind !== "verbatim") return;
    const targetName = ctx.name;
    const start = input.pos;
    for (;;) {
      const ch = input.next;
      if (ch === -1) break;
      if (
        ch === BACKSLASH &&
        matchesLiteral(input, 0, "\\end") &&
        !isAsciiLetterOrAt(input.peek(4)) &&
        peekBracedEnvName(input, 4) === targetName
      ) {
        break;
      }
      input.advance();
    }
    if (input.pos > start) {
      input.acceptToken(VerbatimContent);
    }
  },
  { contextual: true },
);

export const implicitEnd = new ExternalTokenizer(
  (input, stack) => {
    const ctx = stack.context as EnvContext | null;
    if (!ctx || ctx.kind === "verbatim") return;
    if (
      !matchesLiteral(input, 0, "\\end") ||
      isAsciiLetterOrAt(input.peek(4))
    ) {
      return;
    }
    const endName = peekBracedEnvName(input, 4);
    if (!endName || endName === ctx.name) return;
    let parent = ctx.parent;
    while (parent) {
      if (parent.name === endName) {
        input.acceptToken(ImplicitEnd);
        return;
      }
      parent = parent.parent;
    }
  },
  { contextual: true, fallback: true },
);

export const envContext = new ContextTracker<EnvContext | null>({
  start: null,
  shift(context, term) {
    if (term === ImplicitEnd) {
      return context ? context.parent : null;
    }
    return context;
  },
  reduce(context, term, stack, input) {
    if (
      term === BeginEnv ||
      term === BeginMathEnv ||
      term === BeginVerbatimEnv
    ) {
      // Ignore synthetic error-recovery reductions where no input was consumed.
      if (stack.pos === input.pos) return context;
      const envName = peekBracedEnvName(input, 6);
      if (!envName) return context;
      const kind: EnvKind =
        term === BeginVerbatimEnv
          ? "verbatim"
          : term === BeginMathEnv
            ? "math"
            : "normal";
      return new EnvContext(envName, kind, context);
    }
    if (term === EndEnv) {
      return context ? context.parent : null;
    }
    return context;
  },
  hash(context) {
    return context ? context.hash : 0;
  },
  strict: false,
});
