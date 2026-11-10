import {
  LanguageSupport,
  StreamLanguage,
  syntaxTree,
} from "@codemirror/language";
import { styleTags, tags } from "@lezer/highlight";
import {
  Decoration,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@uiw/react-codemirror";
import { latex, latexLanguage } from "codemirror-lang-latex";

import { latexTags } from "../theme-syntax";

export function themedLatex(filename: string) {
  const support = latex({
    fileName: filename,
    enableLinting: false,
    enableAutocomplete: false,
  });
  const commands = latexLanguage.parser.nodeSet.types
    .map((type) => type.name)
    .filter(
      (name) =>
        name.endsWith("CtrlSeq") ||
        name === "CtrlSeq" ||
        name === "Begin" ||
        name === "End",
    )
    .join(" ");
  const language = latexLanguage.configure({
    props: [
      styleTags({
        [commands]: latexTags.command,
        "EnvName DocumentEnvName TabularEnvName EquationEnvName EquationArrayEnvName VerbatimEnvName TikzPictureEnvName FigureEnvName ListEnvName TableEnvName":
          latexTags.environment,
        "MathChar MathSpecialChar Dollar MathDelimiter": latexTags.math,
        "TextArgument/... LiteralArgContent SpaceDelimitedLiteralArgContent BibKeyArgument/...":
          latexTags.argument,
        "OptionalArgument/...": latexTags.option,
        Comment: tags.comment,
      }),
    ],
  });
  return new LanguageSupport(language, [support.support, optionKeys]);
}

function keyDecorations(view: EditorView) {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (node.name !== "OptionalArgument") return;
        const text = view.state.sliceDoc(node.from, node.to);
        for (const match of text.matchAll(
          /(?:\[|,)\s*([a-zA-Z@][\w:@.-]*)(?=\s*=)/g,
        )) {
          const key = match[1];
          if (!key) continue;
          const from = node.from + match.index + match[0].lastIndexOf(key);
          ranges.push(
            Decoration.mark({ class: "cm-latex-option-key" }).range(
              from,
              from + key.length,
            ),
          );
        }
        return false;
      },
    });
  }
  return Decoration.set(ranges, true);
}

const optionKeys = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = keyDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = keyDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

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
