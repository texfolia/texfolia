import { z } from "zod";

import { syntaxStyles, tokenStyle } from "./theme-syntax";

export const maxThemeBytes = 1024 * 1024;
export const colorPattern = /#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})/i
  .source;
const colorSchema = z
  .string()
  .regex(
    new RegExp(`^${colorPattern}$`, "i"),
    "Use a hex color such as #282c34.",
  );
const tokenRuleSchema = z.object({
  scope: z
    .union([z.string().max(16384), z.array(z.string().max(16384)).max(512)])
    .optional(),
  settings: z.object({
    foreground: colorSchema.optional(),
    fontStyle: z
      .string()
      .max(100)
      .regex(/^(?:(?:italic|bold|underline|strikethrough)\s*)*$/)
      .optional(),
  }),
});
export const themeSchema = z.object({
  name: z.string().trim().min(1).max(120).default("Imported theme"),
  type: z.enum(["light", "dark", "hc", "hcLight"]).optional(),
  colors: z
    .record(z.string().max(200), colorSchema)
    .refine((colors) => Object.keys(colors).length <= 2000)
    .default({}),
  tokenColors: z.array(tokenRuleSchema).max(4000).default([]),
});
export type ThemeDefinition = z.infer<typeof themeSchema>;

// VS Code theme files allow JSON comments and trailing commas. Preserve strings.
function jsonWithoutComments(source: string) {
  let output = "";
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      output += char;
      if (char === "\\") output += source[++i] ?? "";
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      output += "\n";
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw new Error("The theme has an unclosed comment.");
      i = end + 1;
      output += " ";
    } else output += char;
  }
  let result = "";
  inString = false;
  for (let i = 0; i < output.length; i++) {
    const char = output[i];
    if (inString) {
      result += char;
      if (char === "\\") result += output[++i] ?? "";
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      result += char;
    } else if (char !== "," || !/^\s*[}\]]/.test(output.slice(i + 1)))
      result += char;
  }
  return result.replace(/^\uFEFF/, "");
}

export function parseTheme(source: string): ThemeDefinition {
  if (new TextEncoder().encode(source).length > maxThemeBytes)
    throw new Error("Choose a theme smaller than 1 MB.");
  let input: unknown;
  try {
    input = JSON.parse(jsonWithoutComments(source));
  } catch {
    throw new Error(
      "This is not valid theme JSON. Paste a VS Code color theme file and try again.",
    );
  }
  if (typeof input === "object" && input !== null && "include" in input)
    throw new Error(
      "This theme includes another file. Import a standalone theme with its colors and tokenColors combined.",
    );
  const result = themeSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      "This theme contains unsupported colors or token rules. Use hex colors and a tokenColors array.",
    );
  if (
    !Object.keys(result.data.colors).length &&
    !result.data.tokenColors.length
  )
    throw new Error(
      "No theme colors found. Choose the color theme JSON, rather than the extension's package.json.",
    );
  return result.data;
}

function palette(
  name: string,
  type: "light" | "dark",
  bg: string,
  fg: string,
  surface: string,
  border: string,
  accent: string,
  comment: string,
  keyword: string,
  string: string,
  number: string,
): ThemeDefinition {
  return themeSchema.parse({
    name,
    type,
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      "sideBar.background": surface,
      "panel.border": border,
      "button.background": accent,
      "button.foreground": "#ffffff",
      focusBorder: accent,
    },
    tokenColors: [
      {
        scope: "comment",
        settings: { foreground: comment, fontStyle: "italic" },
      },
      {
        scope: ["keyword", "support.function", "entity.name.tag"],
        settings: { foreground: keyword },
      },
      {
        scope: ["string", "entity.name.type", "entity.other.attribute-name"],
        settings: { foreground: string },
      },
      {
        scope: ["constant", "variable.parameter", "support.type"],
        settings: { foreground: number },
      },
    ],
  });
}

export const bundledThemes = {
  texfolia: palette(
    "Texfolia",
    "light",
    "#ffffff",
    "#242424",
    "#fafafa",
    "#e5e5e5",
    "#323232",
    "#6a737d",
    "#8250df",
    "#116329",
    "#0550ae",
  ),
  vscodeLight: palette(
    "Light+",
    "light",
    "#ffffff",
    "#000000",
    "#f3f3f3",
    "#e5e5e5",
    "#007acc",
    "#008000",
    "#0000ff",
    "#a31515",
    "#098658",
  ),
  vscodeDark: palette(
    "Dark+",
    "dark",
    "#1e1e1e",
    "#d4d4d4",
    "#252526",
    "#454545",
    "#0e639c",
    "#6a9955",
    "#569cd6",
    "#ce9178",
    "#b5cea8",
  ),
  oneDark: palette(
    "One Dark",
    "dark",
    "#282c34",
    "#abb2bf",
    "#21252b",
    "#3e4451",
    "#4d78cc",
    "#7f848e",
    "#c678dd",
    "#98c379",
    "#d19a66",
  ),
  githubLight: palette(
    "GitHub Light",
    "light",
    "#ffffff",
    "#24292f",
    "#f6f8fa",
    "#d0d7de",
    "#0969da",
    "#6e7781",
    "#cf222e",
    "#0a3069",
    "#0550ae",
  ),
  githubDark: palette(
    "GitHub Dark",
    "dark",
    "#0d1117",
    "#c9d1d9",
    "#161b22",
    "#30363d",
    "#1f6feb",
    "#8b949e",
    "#ff7b72",
    "#a5d6ff",
    "#79c0ff",
  ),
  solarizedLight: palette(
    "Solarized Light",
    "light",
    "#fdf6e3",
    "#657b83",
    "#eee8d5",
    "#d3cbb7",
    "#2075a0",
    "#77878b",
    "#859900",
    "#2aa198",
    "#d33682",
  ),
  solarizedDark: palette(
    "Solarized Dark",
    "dark",
    "#002b36",
    "#839496",
    "#073642",
    "#586e75",
    "#2075a0",
    "#657b83",
    "#859900",
    "#2aa198",
    "#d33682",
  ),
  dracula: palette(
    "Dracula",
    "dark",
    "#282a36",
    "#f8f8f2",
    "#21222c",
    "#44475a",
    "#7655b5",
    "#929cc0",
    "#ff79c6",
    "#f1fa8c",
    "#bd93f9",
  ),
  nord: palette(
    "Nord",
    "dark",
    "#2e3440",
    "#d8dee9",
    "#3b4252",
    "#4c566a",
    "#486985",
    "#8c99ae",
    "#81a1c1",
    "#a3be8c",
    "#b48ead",
  ),
  xcodeLight: palette(
    "Xcode Light",
    "light",
    "#ffffff",
    "#262626",
    "#f2f2f2",
    "#d8d8d8",
    "#0065b3",
    "#5d6c79",
    "#9b2393",
    "#c41a16",
    "#1c00cf",
  ),
};
export const bundledThemeIdSchema = z.custom<keyof typeof bundledThemes>(
  (value): value is keyof typeof bundledThemes =>
    typeof value === "string" && Object.hasOwn(bundledThemes, value),
);
export const appearanceSchema = z.object({
  selection: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("system") }),
    z.object({ kind: z.literal("bundled"), id: bundledThemeIdSchema }),
    z.object({ kind: z.literal("imported"), theme: themeSchema }),
  ]),
  pdfMode: z.enum(["original", "match"]).default("original"),
});
export type Appearance = z.infer<typeof appearanceSchema>;
export const defaultAppearance: Appearance = {
  selection: { kind: "system" },
  pdfMode: "original",
};
export const appearanceStorageKey = (userId: string) =>
  `texfolia.appearance.v1:${userId}`;

function isDark(color: string) {
  const hex = color.slice(1);
  const channels =
    hex.length <= 4
      ? Array.from(hex.slice(0, 3), (c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (
    ((channels[0] ?? 0) * 299 +
      (channels[1] ?? 0) * 587 +
      (channels[2] ?? 0) * 114) /
      1000 <
    128
  );
}

export function resolveTheme(definition: ThemeDefinition) {
  const colors = definition.colors;
  const mode: "light" | "dark" = definition.type
    ? definition.type === "dark" || definition.type === "hc"
      ? "dark"
      : "light"
    : isDark(colors["editor.background"] ?? "#ffffff")
      ? "dark"
      : "light";
  const bg =
    colors["editor.background"] ?? (mode === "dark" ? "#1e1e1e" : "#ffffff");
  const fg =
    colors["editor.foreground"] ?? (mode === "dark" ? "#d4d4d4" : "#242424");
  const mix = (amount: number) => `color-mix(in srgb, ${fg} ${amount}%, ${bg})`;
  const pick = (key: string, fallback: string) => colors[key] ?? fallback;
  const surface = pick("sideBar.background", mix(4));
  const border = pick("panel.border", mix(18));
  const accent = pick("list.activeSelectionBackground", mix(12));
  const primary = pick(
    "button.background",
    mode === "dark" ? "#0e639c" : "#007acc",
  );
  const ring = pick("focusBorder", primary);
  const popup = pick("editorWidget.background", surface);
  const variables = {
    "--background": bg,
    "--foreground": fg,
    "--card": popup,
    "--card-foreground": pick("editorWidget.foreground", fg),
    "--popover": popup,
    "--popover-foreground": pick("editorWidget.foreground", fg),
    "--primary": primary,
    "--primary-foreground": pick("button.foreground", "#ffffff"),
    "--secondary": pick("button.secondaryBackground", surface),
    "--secondary-foreground": pick("button.secondaryForeground", fg),
    "--muted": surface,
    "--muted-foreground": pick("descriptionForeground", mix(72)),
    "--accent": accent,
    "--accent-foreground": pick("list.activeSelectionForeground", fg),
    "--destructive": pick(
      "errorForeground",
      mode === "dark" ? "#f48771" : "#b42318",
    ),
    "--border": border,
    "--input": pick("input.background", surface),
    "--input-foreground": pick("input.foreground", fg),
    "--input-placeholder": pick("input.placeholderForeground", mix(65)),
    "--panel-background": pick("panel.background", bg),
    "--ring": ring,
    "--sidebar": surface,
    "--sidebar-foreground": pick("sideBar.foreground", fg),
    "--sidebar-primary": primary,
    "--sidebar-primary-foreground": pick("button.foreground", "#ffffff"),
    "--sidebar-accent": pick("list.inactiveSelectionBackground", accent),
    "--sidebar-accent-foreground": pick("list.inactiveSelectionForeground", fg),
    "--sidebar-border": pick("sideBar.border", border),
    "--sidebar-ring": ring,
    "--activity-background": pick("activityBar.background", surface),
    "--activity-foreground": pick("activityBar.foreground", fg),
    "--status-background": pick("statusBar.background", surface),
    "--status-foreground": pick("statusBar.foreground", fg),
    "--tab-active-background": pick("tab.activeBackground", bg),
    "--tab-active-foreground": pick("tab.activeForeground", fg),
    "--tab-inactive-background": pick("tab.inactiveBackground", surface),
    "--tab-inactive-foreground": pick("tab.inactiveForeground", mix(72)),
    "--tab-border": pick("tab.border", border),
    "--tab-header": pick("editorGroupHeader.tabsBackground", surface),
    "--selection": pick("editor.selectionBackground", accent),
    "--selection-foreground": pick("editor.selectionForeground", fg),
    "--overlay": "#00000066",
    "--pdf-surround": mix(9),
    "--pdf-original-surround": "#e4e4e7",
    "--pdf-original-foreground": "#242424",
  };
  const settings = {
    background: bg,
    foreground: fg,
    caret: pick("editorCursor.foreground", fg),
    selection: variables["--selection"],
    selectionMatch: pick("editor.selectionHighlightBackground", accent),
    lineHighlight: pick("editor.lineHighlightBackground", mix(4)),
    gutterBackground: pick("editorGutter.background", bg),
    gutterForeground: pick("editorLineNumber.foreground", mix(60)),
    gutterActiveForeground: pick("editorLineNumber.activeForeground", fg),
    gutterBorder: border,
  };
  const editorStyles = {
    "&.cm-focused": { outline: "none" },
    ".cm-panels, .cm-tooltip": {
      backgroundColor: popup,
      color: fg,
      borderColor: border,
    },
    ".cm-searchMatch": {
      backgroundColor: pick("editor.findMatchHighlightBackground", accent),
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: pick("editor.findMatchBackground", accent),
      outline: `1px solid ${ring}`,
    },
    "&.cm-focused .cm-matchingBracket": {
      backgroundColor: pick("editorBracketMatch.background", accent),
      outline: `1px solid ${pick("editorBracketMatch.border", ring)}`,
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: accent,
      color: variables["--accent-foreground"],
    },
    ".cm-textfield, .cm-button": {
      background: variables["--input"],
      color: fg,
      border: `1px solid ${border}`,
    },
    ".cm-latex-option-key": tokenStyle(
      ["variable.parameter.key.tex", "entity.other.attribute-name.tex"],
      definition.tokenColors,
    ),
  };
  return {
    name: definition.name,
    mode,
    variables,
    settings,
    styles: syntaxStyles(definition.tokenColors),
    editorStyles,
  };
}

export function selectedTheme(appearance: Appearance, dark: boolean) {
  switch (appearance.selection.kind) {
    case "system":
      return dark ? bundledThemes.vscodeDark : bundledThemes.texfolia;
    case "bundled":
      return bundledThemes[appearance.selection.id];
    case "imported":
      return appearance.selection.theme;
  }
}
