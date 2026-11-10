import type { TagStyle } from "@codemirror/language";
import { Tag, tags } from "@lezer/highlight";

export const latexTags = {
  command: Tag.define(tags.keyword),
  environment: Tag.define(tags.className),
  math: Tag.define(tags.variableName),
  argument: Tag.define(tags.string),
  option: Tag.define(tags.attributeName),
  key: Tag.define(tags.propertyName),
  bibField: Tag.define(tags.propertyName),
};

const scopeTags: { tag: Tag; scopes: string[] }[] = [
  { tag: tags.comment, scopes: ["comment.line.percentage.tex", "comment"] },
  { tag: tags.keyword, scopes: ["keyword.control"] },
  { tag: tags.operator, scopes: ["keyword.operator"] },
  { tag: tags.string, scopes: ["string.quoted.double"] },
  { tag: tags.number, scopes: ["constant.numeric"] },
  { tag: tags.bool, scopes: ["constant.language.boolean"] },
  { tag: tags.variableName, scopes: ["variable.other"] },
  { tag: tags.propertyName, scopes: ["variable.other.property"] },
  {
    tag: tags.function(tags.variableName),
    scopes: ["entity.name.function", "support.function"],
  },
  { tag: tags.typeName, scopes: ["entity.name.type", "support.type"] },
  { tag: tags.className, scopes: ["entity.name.class", "support.class"] },
  { tag: tags.attributeName, scopes: ["entity.other.attribute-name"] },
  { tag: tags.tagName, scopes: ["entity.name.tag"] },
  { tag: tags.meta, scopes: ["meta", "punctuation.definition"] },
  {
    tag: tags.bracket,
    scopes: ["punctuation.section", "punctuation.definition.arguments.tex"],
  },
  { tag: tags.heading, scopes: ["markup.heading"] },
  { tag: tags.strong, scopes: ["markup.bold"] },
  { tag: tags.emphasis, scopes: ["markup.italic"] },
  { tag: tags.link, scopes: ["markup.underline.link"] },
  { tag: tags.invalid, scopes: ["invalid"] },
  {
    tag: latexTags.command,
    scopes: ["support.function.general.tex", "keyword.control.tex"],
  },
  { tag: latexTags.environment, scopes: ["entity.name.type.environment.tex"] },
  {
    tag: latexTags.math,
    scopes: ["string.other.math.tex", "variable.other.math.tex"],
  },
  { tag: latexTags.argument, scopes: ["string.other.tex"] },
  { tag: latexTags.option, scopes: ["entity.other.attribute-name.tex"] },
  {
    tag: latexTags.key,
    scopes: ["variable.parameter.key.tex", "entity.other.attribute-name.tex"],
  },
  {
    tag: latexTags.bibField,
    scopes: [
      "support.type.property-name.bibtex",
      "entity.other.attribute-name.bibtex",
    ],
  },
];

export type TokenRule = {
  scope?: string | string[];
  settings: { foreground?: string; fontStyle?: string };
};

// Complex ancestor/negative selectors are approximated by their final scope.
export function tokenStyle(scopes: string[], rules: TokenRule[]) {
  let foreground: string | undefined;
  let fontStyle: string | undefined;
  let colorRank = -1;
  let fontRank = -1;
  for (const rule of rules) {
    const selectors =
      rule.scope === undefined
        ? [""]
        : (Array.isArray(rule.scope) ? rule.scope : [rule.scope]).flatMap(
            (scope) => scope.split(","),
          );
    for (const selector of selectors) {
      const leaf = selector.trim().split(/\s+/).at(-1) ?? "";
      if (
        leaf &&
        !scopes.some((scope) => scope === leaf || scope.startsWith(`${leaf}.`))
      )
        continue;
      const rank = leaf.length;
      if (rule.settings.foreground !== undefined && rank >= colorRank) {
        foreground = rule.settings.foreground;
        colorRank = rank;
      }
      if (rule.settings.fontStyle !== undefined && rank >= fontRank) {
        fontStyle = rule.settings.fontStyle;
        fontRank = rank;
      }
    }
  }
  const font = fontStyle?.split(/\s+/) ?? [];
  return {
    ...(foreground === undefined ? {} : { color: foreground }),
    ...(fontStyle === undefined
      ? {}
      : {
          fontWeight: font.includes("bold") ? "bold" : "normal",
          fontStyle: font.includes("italic") ? "italic" : "normal",
          textDecoration:
            [
              font.includes("underline") ? "underline" : "",
              font.includes("strikethrough") ? "line-through" : "",
            ]
              .filter(Boolean)
              .join(" ") || "none",
        }),
  };
}

export function syntaxStyles(rules: TokenRule[]): TagStyle[] {
  return scopeTags.flatMap(({ tag, scopes }) => {
    const style = tokenStyle(scopes, rules);
    return Object.keys(style).length ? [{ tag, ...style }] : [];
  });
}
