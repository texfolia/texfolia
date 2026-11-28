import { styleTags, tags } from "@lezer/highlight";

import { latexTags } from "./tags.js";

export const latexHighlighting = styleTags({
  "CommandName BeginCommand BeginMathCommand BeginVerbatimCommand EndCommand":
    latexTags.command,
  "EnvName!": latexTags.environment,
  "InlineMath/... DisplayMath/... MathBody/...": latexTags.math,
  "BracedGroup/...": latexTags.argument,
  "OptionalArgument/...": latexTags.option,
  "InlineVerbatim VerbatimContent": latexTags.verbatim,
  Comment: tags.comment,
  EscapedChar: tags.escape,
  Number: tags.number,
  MathOperator: tags.operator,
  "{ }": tags.brace,
  "[ ]": tags.squareBracket,
});
