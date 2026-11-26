import { StreamLanguage } from "@codemirror/language";
import { tags } from "@lezer/highlight";

import { latexTags } from "./tags.js";

/** StreamLanguage definition for BibTeX (`.bib`) files. */
export const bibtexLanguage = StreamLanguage.define({
  name: "bibtex",
  startState: () => ({
    depth: 0,
    quoted: false,
    value: false,
    entryKey: false,
    comment: false,
  }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^%.*/)) return "comment";
    if (state.comment) {
      const char = stream.next();
      if (char === "{") state.depth++;
      if (char === "}") {
        state.depth--;
        if (state.depth <= 0) state.comment = false;
      }
      return "comment";
    }
    if (!state.quoted && state.depth <= 1 && stream.match(/^@\w+/)) {
      state.comment = stream.current().toLowerCase() === "@comment";
      state.entryKey = true;
      state.value = false;
      return "entry";
    }
    if (state.quoted || (state.value && state.depth > 1)) {
      const char = stream.next();
      if (char === "\\") stream.next();
      else if (char === '"' && state.depth <= 1) state.quoted = !state.quoted;
      else if (!state.quoted && char === "{") state.depth++;
      else if (!state.quoted && char === "}") state.depth--;
      return "string";
    }
    if (stream.match(/^[a-zA-Z][\w-]*(?=\s*=)/)) {
      state.entryKey = false;
      return "field";
    }
    if (state.entryKey && stream.match(/^[^\s{},()]+/)) {
      state.entryKey = false;
      return "citation";
    }
    if (stream.match(/^\d+/)) return "number";
    const char = stream.next();
    if (char === "{" || char === "(") state.depth++;
    if (char === "}" || char === ")") {
      state.depth = Math.max(0, state.depth - 1);
      state.value = false;
    }
    if (char === '"') {
      state.quoted = true;
      return "string";
    }
    if (char === "=") {
      state.value = true;
      return "operator";
    }
    if (char === ",") state.value = false;
    return "punctuation";
  },
  tokenTable: {
    entry: tags.keyword,
    field: latexTags.bibField,
    citation: tags.labelName,
  },
  languageData: { commentTokens: { line: "%" } },
});
