import {
  delimitedIndent,
  foldInside,
  foldNodeProp,
  indentNodeProp,
  LanguageSupport,
  LRLanguage,
} from "@codemirror/language";

import { parser } from "./bibtex-parser.js";

/** Lezer `LRLanguage` for BibTeX (`.bib`) files. */
export const bibtexLanguage = LRLanguage.define({
  name: "bibtex",
  parser: parser.configure({
    props: [
      indentNodeProp.add({
        Entry: delimitedIndent({ closing: "}" }),
        StringEntry: delimitedIndent({ closing: "}" }),
        PreambleEntry: delimitedIndent({ closing: "}" }),
      }),
      foldNodeProp.add({
        Entry: foldInside,
        StringEntry: foldInside,
        PreambleEntry: foldInside,
        CommentEntry: foldInside,
      }),
    ],
  }),
  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["{", "(", '"'] },
  },
});

/** CodeMirror 6 language support for BibTeX (`.bib`) files. */
export function bibtex(): LanguageSupport {
  return new LanguageSupport(bibtexLanguage);
}
