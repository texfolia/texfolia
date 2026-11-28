import {
  LanguageDescription,
  type LanguageSupport,
} from "@codemirror/language";

import { bibtex } from "./bibtex.js";
import { bst } from "./bst.js";
import { latex, type LatexConfig } from "./latex-support.js";

export const LATEX_EXTENSIONS: readonly string[] = [
  "tex",
  "ltx",
  "sty",
  "cls",
  "bbx",
  "cbx",
  "lbx",
  "dtx",
  "ins",
];

export const BIBTEX_EXTENSIONS: readonly string[] = ["bib"];

export const BST_EXTENSIONS: readonly string[] = ["bst"];

const LATEX_EXT_SET = new Set(LATEX_EXTENSIONS);
const BIBTEX_EXT_SET = new Set(BIBTEX_EXTENSIONS);
const BST_EXT_SET = new Set(BST_EXTENSIONS);

function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * CodeMirror `LanguageDescription` entries for LaTeX documents, packages,
 * classes, BibLaTeX styles, BibTeX databases, and BibTeX style files.
 */
export const texLanguageDescriptions: readonly LanguageDescription[] = [
  LanguageDescription.of({
    name: "LaTeX",
    alias: ["tex", "ltx", "sty", "cls", "bbx", "cbx", "lbx", "dtx", "ins"],
    extensions: [...LATEX_EXTENSIONS],
    support: latex(),
  }),
  LanguageDescription.of({
    name: "BibTeX",
    alias: ["bib"],
    extensions: [...BIBTEX_EXTENSIONS],
    support: bibtex(),
  }),
  LanguageDescription.of({
    name: "BibTeX Style",
    alias: ["bst"],
    extensions: [...BST_EXTENSIONS],
    support: bst(),
  }),
];

/** Returns true when `filename` uses a LaTeX-syntax extension (`.tex`, `.sty`, `.cls`, `.bbx`, `.cbx`, etc.). */
export function isLatexFilename(filename: string): boolean {
  return LATEX_EXT_SET.has(extensionOf(filename));
}

/** Returns the matching CodeMirror `LanguageSupport` for a TeX-family filename, or `null` if unrecognized. */
export function languageForFilename(
  filename: string,
  config?: LatexConfig,
): LanguageSupport | null {
  const ext = extensionOf(filename);
  if (LATEX_EXT_SET.has(ext)) return latex(config);
  if (BIBTEX_EXT_SET.has(ext)) return bibtex();
  if (BST_EXT_SET.has(ext)) return bst();
  return null;
}
