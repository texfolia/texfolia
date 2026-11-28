import {
  HighlightStyle,
  syntaxHighlighting,
  type TagStyle,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { EditorView, type Extension } from "@uiw/react-codemirror";

import { catalogTheme, type ThemeDefinition, type ThemeId } from "./themes";

function createThemeExtension(
  definition: ThemeDefinition,
  styles: readonly TagStyle[],
): Extension {
  const { settings, mode } = definition;
  const gutters: Record<string, string> = {};
  if (settings.gutterBackground)
    gutters.backgroundColor = settings.gutterBackground;
  if (settings.gutterForeground) gutters.color = settings.gutterForeground;
  if (settings.gutterBorder) gutters.borderRightColor = settings.gutterBorder;

  const activeLineGutter: Record<string, string> = {};
  if (settings.gutterActiveForeground)
    activeLineGutter.color = settings.gutterActiveForeground;
  if (settings.lineHighlight)
    activeLineGutter.backgroundColor = settings.lineHighlight;

  const rules: Record<string, Record<string, string>> = {
    "&": {
      backgroundColor: settings.background,
      color: settings.foreground,
    },
    ".cm-gutters": gutters,
    ".cm-activeLineGutter": activeLineGutter,
  };
  if (settings.caret) {
    rules[".cm-content"] = { caretColor: settings.caret };
    rules[".cm-cursor, .cm-dropCursor"] = { borderLeftColor: settings.caret };
  }
  if (settings.lineHighlight)
    rules[".cm-activeLine"] = { backgroundColor: settings.lineHighlight };
  if (settings.selection)
    rules[
      "&.cm-focused .cm-selectionBackground, & .cm-line::selection, & .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection"
    ] = { background: `${settings.selection} !important` };
  if (settings.selectionMatch)
    rules["& .cm-selectionMatch"] = {
      backgroundColor: settings.selectionMatch,
    };

  return [
    EditorView.theme(rules, { dark: mode === "dark" }),
    syntaxHighlighting(HighlightStyle.define(styles)),
  ];
}

function solarizedStyles(palette: {
  keyword: string;
  variable: string;
  fn: string;
  string: string;
  constant: string;
  class: string;
  number: string;
  type: string;
  regexp: string;
  comment: string;
  tag: string;
  heading: string;
  invalid: string;
}): readonly TagStyle[] {
  return [
    { tag: [t.keyword, t.operator, t.operatorKeyword], color: palette.keyword },
    {
      tag: [
        t.name,
        t.deleted,
        t.character,
        t.macroName,
        t.definition(t.name),
        t.separator,
        t.atom,
        t.bool,
        t.special(t.variableName),
      ],
      color: palette.variable,
    },
    {
      tag: [t.propertyName, t.function(t.variableName), t.labelName],
      color: palette.fn,
    },
    {
      tag: [t.processingInstruction, t.string, t.inserted, t.special(t.string)],
      color: palette.string,
    },
    {
      tag: [t.color, t.constant(t.name), t.standard(t.name)],
      color: palette.constant,
    },
    { tag: [t.className], color: palette.class },
    {
      tag: [t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace],
      color: palette.number,
    },
    { tag: [t.typeName], color: palette.type },
    { tag: [t.url, t.escape, t.regexp, t.link], color: palette.regexp },
    { tag: [t.meta, t.comment], color: palette.comment },
    { tag: t.tagName, color: palette.tag },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.link, textDecoration: "underline" },
    { tag: t.heading, fontWeight: "bold", color: palette.heading },
    { tag: t.invalid, color: palette.invalid },
    { tag: t.strikethrough, textDecoration: "line-through" },
  ];
}

const themeStyles: Record<ThemeId, readonly TagStyle[]> = {
  dracula: [
    { tag: t.comment, color: "#6272a4" },
    { tag: t.string, color: "#f1fa8c" },
    { tag: t.atom, color: "#bd93f9" },
    { tag: t.meta, color: "#f8f8f2" },
    { tag: [t.keyword, t.operator, t.tagName], color: "#ff79c6" },
    { tag: [t.function(t.propertyName), t.propertyName], color: "#66d9ef" },
    {
      tag: [
        t.definition(t.variableName),
        t.function(t.variableName),
        t.className,
        t.attributeName,
      ],
      color: "#50fa7b",
    },
  ],
  githubDark: [
    { tag: [t.standard(t.tagName), t.tagName], color: "#7ee787" },
    { tag: [t.comment, t.bracket], color: "#8b949e" },
    { tag: [t.className, t.propertyName], color: "#d2a8ff" },
    {
      tag: [t.variableName, t.attributeName, t.number, t.operator],
      color: "#79c0ff",
    },
    { tag: [t.keyword, t.typeName, t.typeOperator], color: "#ff7b72" },
    { tag: [t.string, t.meta, t.regexp], color: "#a5d6ff" },
    { tag: [t.name, t.quote], color: "#7ee787" },
    { tag: [t.heading, t.strong], color: "#d2a8ff", fontWeight: "bold" },
    { tag: [t.emphasis], color: "#d2a8ff", fontStyle: "italic" },
    { tag: [t.deleted], color: "#ffdcd7", backgroundColor: "#ffeef0" },
    { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#ffab70" },
    { tag: t.link, textDecoration: "underline" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.invalid, color: "#f97583" },
  ],
  githubLight: [
    { tag: [t.standard(t.tagName), t.tagName], color: "#116329" },
    { tag: [t.comment, t.bracket], color: "#6a737d" },
    { tag: [t.className, t.propertyName], color: "#6f42c1" },
    {
      tag: [t.variableName, t.attributeName, t.number, t.operator],
      color: "#005cc5",
    },
    { tag: [t.keyword, t.typeName, t.typeOperator], color: "#d73a49" },
    { tag: [t.string, t.meta, t.regexp], color: "#032f62" },
    { tag: [t.name, t.quote], color: "#22863a" },
    { tag: [t.heading, t.strong], color: "#24292e", fontWeight: "bold" },
    { tag: [t.emphasis], color: "#24292e", fontStyle: "italic" },
    { tag: [t.deleted], color: "#b31d28", backgroundColor: "#ffeef0" },
    { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#e36209" },
    { tag: [t.url, t.escape, t.regexp, t.link], color: "#032f62" },
    { tag: t.link, textDecoration: "underline" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.invalid, color: "#cb2431" },
  ],
  gruvboxDark: [
    { tag: [t.keyword, t.operator, t.operatorKeyword], color: "#fb4934" },
    {
      tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName],
      color: "#8ec07c",
    },
    {
      tag: [
        t.variableName,
        t.angleBracket,
        t.processingInstruction,
        t.inserted,
      ],
      color: "#83a598",
    },
    {
      tag: [t.function(t.variableName)],
      color: "#b8bb26",
      fontWeight: "bold",
    },
    {
      tag: [t.labelName, t.definition(t.name), t.separator, t.brace, t.string],
      color: "#ebdbb2",
    },
    {
      tag: [
        t.color,
        t.constant(t.name),
        t.standard(t.name),
        t.number,
        t.changed,
        t.modifier,
        t.self,
        t.namespace,
        t.url,
        t.escape,
        t.special(t.string),
        t.atom,
        t.bool,
        t.special(t.variableName),
      ],
      color: "#d3869b",
    },
    { tag: [t.annotation, t.contentSeparator], color: "#fb4934" },
    { tag: [t.typeName, t.className, t.meta], color: "#fabd2f" },
    { tag: [t.tagName], color: "#8ec07c", fontWeight: "bold" },
    { tag: [t.squareBracket], color: "#fe8019" },
    { tag: [t.attributeName, t.regexp], color: "#8ec07c" },
    { tag: [t.quote], color: "#928374" },
    { tag: t.link, color: "#a89984", textDecoration: "underline" },
    { tag: [t.comment], color: "#928374", fontStyle: "italic" },
    { tag: t.strong, fontWeight: "bold", color: "#fe8019" },
    { tag: t.emphasis, fontStyle: "italic", color: "#b8bb26" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    {
      tag: [t.heading, t.heading1, t.heading2],
      fontWeight: "bold",
      color: "#b8bb26",
    },
    { tag: [t.heading3, t.heading4], fontWeight: "bold", color: "#fabd2f" },
    { tag: [t.heading5, t.heading6], color: "#fabd2f" },
    { tag: t.invalid, color: "#fe8019", borderBottom: "1px dotted #fb4934" },
  ],
  gruvboxLight: [
    { tag: [t.keyword, t.operator, t.operatorKeyword], color: "#9d0006" },
    {
      tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName],
      color: "#427b58",
    },
    {
      tag: [
        t.variableName,
        t.angleBracket,
        t.processingInstruction,
        t.inserted,
      ],
      color: "#076678",
    },
    {
      tag: [t.function(t.variableName)],
      color: "#79740e",
      fontWeight: "bold",
    },
    {
      tag: [t.labelName, t.definition(t.name), t.separator, t.brace, t.string],
      color: "#3c3836",
    },
    {
      tag: [
        t.color,
        t.constant(t.name),
        t.standard(t.name),
        t.number,
        t.changed,
        t.modifier,
        t.self,
        t.namespace,
        t.url,
        t.escape,
        t.special(t.string),
        t.atom,
        t.bool,
        t.special(t.variableName),
      ],
      color: "#8f3f71",
    },
    { tag: [t.annotation, t.contentSeparator], color: "#9d0006" },
    { tag: [t.typeName, t.className, t.meta], color: "#b57614" },
    { tag: [t.tagName], color: "#427b58", fontWeight: "bold" },
    { tag: [t.squareBracket], color: "#af3a03" },
    { tag: [t.attributeName, t.regexp], color: "#427b58" },
    { tag: [t.quote], color: "#928374" },
    { tag: t.link, color: "#7c6f64", textDecoration: "underline" },
    { tag: [t.comment], color: "#928374", fontStyle: "italic" },
    { tag: t.strong, fontWeight: "bold", color: "#af3a03" },
    { tag: t.emphasis, fontStyle: "italic", color: "#79740e" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    {
      tag: [t.heading, t.heading1, t.heading2],
      fontWeight: "bold",
      color: "#79740e",
    },
    { tag: [t.heading3, t.heading4], fontWeight: "bold", color: "#b57614" },
    { tag: [t.heading5, t.heading6], color: "#b57614" },
    { tag: t.invalid, color: "#af3a03", borderBottom: "1px dotted #9d0006" },
  ],
  nord: [
    {
      tag: [
        t.keyword,
        t.color,
        t.constant(t.name),
        t.standard(t.name),
        t.regexp,
      ],
      color: "#5e81ac",
    },
    {
      tag: [
        t.name,
        t.deleted,
        t.character,
        t.propertyName,
        t.macroName,
        t.meta,
      ],
      color: "#88c0d0",
    },
    {
      tag: [
        t.variableName,
        t.function(t.variableName),
        t.brace,
        t.url,
        t.escape,
        t.special(t.string),
        t.processingInstruction,
        t.inserted,
      ],
      color: "#8fbcbb",
    },
    { tag: [t.labelName], color: "#81a1c1" },
    {
      tag: [
        t.definition(t.name),
        t.separator,
        t.operator,
        t.operatorKeyword,
        t.string,
      ],
      color: "#a3be8c",
    },
    { tag: [t.annotation], color: "#d30102" },
    {
      tag: [
        t.number,
        t.changed,
        t.modifier,
        t.self,
        t.namespace,
        t.tagName,
        t.quote,
      ],
      color: "#b48ead",
    },
    {
      tag: [t.typeName, t.className, t.attributeName, t.contentSeparator],
      color: "#ebcb8b",
    },
    { tag: [t.squareBracket], color: "#bf616a" },
    {
      tag: [t.angleBracket, t.atom, t.bool, t.special(t.variableName)],
      color: "#d08770",
    },
    { tag: t.link, color: "#a3be8c", textDecoration: "underline" },
    { tag: [t.monospace], color: "#d8dee9", fontStyle: "italic" },
    { tag: [t.comment], color: "#4c566a", fontStyle: "italic" },
    { tag: t.strong, fontWeight: "bold", color: "#5e81ac" },
    { tag: t.emphasis, fontStyle: "italic", color: "#5e81ac" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    {
      tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4],
      fontWeight: "bold",
      color: "#5e81ac",
    },
    { tag: [t.heading5, t.heading6], color: "#5e81ac" },
    { tag: t.invalid, color: "#434c5e", borderBottom: "1px dotted #d30102" },
  ],
  solarizedDark: solarizedStyles({
    keyword: "#859900",
    variable: "#268BD2",
    fn: "#268BD2",
    string: "#2AA198",
    constant: "#CB4B16",
    class: "#268BD2",
    number: "#D33682",
    type: "#859900",
    regexp: "#DC322F",
    comment: "#586E75",
    tag: "#268BD2",
    heading: "#268BD2",
    invalid: "#DC322F",
  }),
  solarizedLight: solarizedStyles({
    keyword: "#859900",
    variable: "#268BD2",
    fn: "#268BD2",
    string: "#2AA198",
    constant: "#CB4B16",
    class: "#268BD2",
    number: "#D33682",
    type: "#859900",
    regexp: "#DC322F",
    comment: "#93A1A1",
    tag: "#268BD2",
    heading: "#268BD2",
    invalid: "#DC322F",
  }),
  tokyoNight: [
    {
      tag: [
        t.keyword,
        t.color,
        t.constant(t.name),
        t.standard(t.name),
        t.operator,
        t.operatorKeyword,
      ],
      color: "#bb9af7",
    },
    {
      tag: [
        t.name,
        t.deleted,
        t.character,
        t.macroName,
        t.definition(t.name),
        t.separator,
        t.className,
        t.atom,
        t.bool,
        t.special(t.variableName),
      ],
      color: "#c0caf5",
    },
    {
      tag: [t.propertyName, t.function(t.variableName), t.labelName],
      color: "#7aa2f7",
    },
    {
      tag: [t.processingInstruction, t.string, t.inserted, t.special(t.string)],
      color: "#9ece6a",
    },
    {
      tag: [t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace],
      color: "#ff9e64",
    },
    { tag: [t.typeName], color: "#0db9d7" },
    { tag: [t.url, t.escape, t.regexp, t.link], color: "#b4f9f8" },
    { tag: [t.meta, t.comment], color: "#444b6a" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.link, textDecoration: "underline" },
    { tag: t.heading, fontWeight: "bold", color: "#89ddff" },
    { tag: t.invalid, color: "#ff5370" },
    { tag: t.strikethrough, textDecoration: "line-through" },
  ],
  tokyoNightDay: [
    {
      tag: [t.keyword, t.typeName, t.operator, t.operatorKeyword],
      color: "#007197",
    },
    {
      tag: [
        t.name,
        t.deleted,
        t.character,
        t.macroName,
        t.propertyName,
        t.function(t.variableName),
        t.labelName,
        t.color,
        t.constant(t.name),
        t.standard(t.name),
        t.definition(t.name),
        t.separator,
        t.className,
        t.atom,
        t.bool,
        t.special(t.variableName),
      ],
      color: "#3760bf",
    },
    {
      tag: [
        t.processingInstruction,
        t.string,
        t.inserted,
        t.special(t.string),
        t.url,
        t.escape,
        t.regexp,
        t.link,
      ],
      color: "#587539",
    },
    {
      tag: [t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace],
      color: "#b15c00",
    },
    { tag: [t.meta, t.comment], color: "#848cb5" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.link, textDecoration: "underline" },
    { tag: t.heading, fontWeight: "bold", color: "#b15c00" },
    { tag: t.invalid, color: "#f52a65" },
    { tag: t.strikethrough, textDecoration: "line-through" },
  ],
  vscodeDark: [
    {
      tag: [
        t.keyword,
        t.operatorKeyword,
        t.modifier,
        t.color,
        t.constant(t.name),
        t.standard(t.name),
        t.standard(t.tagName),
        t.special(t.brace),
        t.atom,
        t.bool,
        t.special(t.variableName),
      ],
      color: "#569cd6",
    },
    { tag: [t.controlKeyword, t.moduleKeyword], color: "#c586c0" },
    {
      tag: [
        t.name,
        t.deleted,
        t.character,
        t.macroName,
        t.propertyName,
        t.variableName,
        t.labelName,
        t.definition(t.name),
      ],
      color: "#9cdcfe",
    },
    { tag: t.heading, fontWeight: "bold", color: "#9cdcfe" },
    {
      tag: [
        t.typeName,
        t.className,
        t.tagName,
        t.changed,
        t.annotation,
        t.self,
        t.namespace,
      ],
      color: "#4ec9b0",
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName)],
      color: "#dcdcaa",
    },
    { tag: [t.number], color: "#b5cea8" },
    {
      tag: [t.operator, t.punctuation, t.separator, t.url, t.escape],
      color: "#d4d4d4",
    },
    { tag: [t.regexp], color: "#d16969" },
    {
      tag: [t.special(t.string), t.processingInstruction, t.string, t.inserted],
      color: "#ce9178",
    },
    { tag: [t.angleBracket], color: "#808080" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.meta, t.comment], color: "#6a9955" },
    { tag: t.link, color: "#6a9955", textDecoration: "underline" },
    { tag: t.invalid, color: "#ff0000" },
  ],
  vscodeLight: [
    {
      tag: [
        t.keyword,
        t.operatorKeyword,
        t.modifier,
        t.color,
        t.constant(t.name),
        t.standard(t.name),
        t.standard(t.tagName),
        t.special(t.brace),
        t.atom,
        t.bool,
        t.special(t.variableName),
      ],
      color: "#0000ff",
    },
    { tag: [t.moduleKeyword, t.controlKeyword], color: "#af00db" },
    {
      tag: [
        t.name,
        t.deleted,
        t.character,
        t.macroName,
        t.propertyName,
        t.variableName,
        t.labelName,
        t.definition(t.name),
      ],
      color: "#0070c1",
    },
    { tag: t.heading, fontWeight: "bold", color: "#0070c1" },
    {
      tag: [
        t.typeName,
        t.className,
        t.tagName,
        t.changed,
        t.annotation,
        t.self,
        t.namespace,
      ],
      color: "#267f99",
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName)],
      color: "#795e26",
    },
    { tag: [t.number], color: "#098658" },
    {
      tag: [
        t.operator,
        t.punctuation,
        t.separator,
        t.url,
        t.escape,
        t.angleBracket,
      ],
      color: "#383a42",
    },
    { tag: [t.regexp], color: "#af00db" },
    {
      tag: [t.special(t.string), t.processingInstruction, t.string, t.inserted],
      color: "#a31515",
    },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.meta, t.comment], color: "#008000" },
    { tag: t.link, color: "#4078f2", textDecoration: "underline" },
    { tag: t.invalid, color: "#e45649" },
  ],
};

const loadedExtensions = new Map<ThemeId, Extension>();

function buildExtension(id: ThemeId): Extension {
  let extension = loadedExtensions.get(id);
  if (!extension) {
    extension = createThemeExtension(catalogTheme(id), themeStyles[id]);
    loadedExtensions.set(id, extension);
  }
  return extension;
}

// Pre-build the system default pair so initial editor render is synchronous.
buildExtension("githubLight");
buildExtension("githubDark");

/** The theme's CodeMirror extension if it has loaded, otherwise undefined. */
export function loadedThemeExtension(id: ThemeId) {
  return loadedExtensions.get(id);
}

export function loadThemeExtension(id: ThemeId): Promise<Extension> {
  return Promise.resolve(buildExtension(id));
}

/** Lets the app's colors wait for the matching editor theme. */
export const editorThemes = {
  loaded: (id: ThemeId) => loadedExtensions.has(id),
  load: loadThemeExtension,
};
