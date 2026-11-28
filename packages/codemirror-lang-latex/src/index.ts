export { bibtex, bibtexLanguage } from "./bibtex.js";
export { bibtexHighlighting } from "./bibtex-highlight.js";
export { bst, bstLanguage } from "./bst.js";
export { latexCompletionSource } from "./completion.js";
export { latexHighlighting } from "./highlight.js";
export {
  type CodeLanguageResolver,
  latex,
  type LatexConfig,
  latexLanguage,
} from "./latex-support.js";
export {
  BIBTEX_EXTENSIONS,
  BST_EXTENSIONS,
  isLatexFilename,
  languageForFilename,
  LATEX_EXTENSIONS,
  texLanguageDescriptions,
} from "./languages.js";
export { latexLinter, type LatexLinterOptions } from "./lint.js";
export { latexTags } from "./tags.js";
export { MATH_ENVS, VERBATIM_ENVS } from "./tokens.js";
