import { LanguageSupport, StreamLanguage } from "@codemirror/language";

const KEYWORDS = new Set([
  "ENTRY",
  "EXECUTE",
  "FUNCTION",
  "INTEGERS",
  "ITERATE",
  "MACRO",
  "READ",
  "REVERSE",
  "SORT",
  "STRINGS",
]);

/** `StreamLanguage` definition for BibTeX style (`.bst`) files. */
export const bstLanguage = StreamLanguage.define({
  name: "bst",
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^%.*/)) return "comment";
    if (stream.match(/^"[^"]*"/)) return "string";
    if (stream.match(/^#-?\d+/)) return "number";
    if (stream.match(/^'[a-zA-Z0-9._$:-]+/)) return "atom";
    if (stream.match(/^:=|^[=<>+\-*]/)) return "operator";
    if (stream.match(/^[{}]/)) return "brace";
    if (stream.match(/^[a-zA-Z][a-zA-Z0-9._-]*\$/)) return "builtin";
    if (stream.match(/^[a-zA-Z][a-zA-Z0-9._-]*/)) {
      return KEYWORDS.has(stream.current().toUpperCase())
        ? "keyword"
        : "variableName";
    }
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["{", '"'] },
  },
});

/** CodeMirror 6 language support for BibTeX style (`.bst`) files. */
export function bst(): LanguageSupport {
  return new LanguageSupport(bstLanguage);
}
