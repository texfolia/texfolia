import { themeCatalog as catalog, type ThemeId } from "./theme-catalog";

export type { ThemeId };

export type ThemeSettings = {
  background: string;
  foreground: string;
  caret?: string;
  selection?: string;
  selectionMatch?: string;
  lineHighlight?: string;
  gutterBackground?: string;
  gutterForeground?: string;
  gutterActiveForeground?: string;
  gutterBorder?: string;
};
export type ThemeDefinition = {
  id: ThemeId;
  name: string;
  mode: "light" | "dark";
  settings: ThemeSettings;
};

// Static metadata for curated themes. The root route applies these colors, so
// this module must not import CodeMirror or Zod; see theme-extensions.ts and
// appearance.ts.
export const themeCatalog: readonly ThemeDefinition[] = catalog;

const themesById = new Map<string, ThemeDefinition>(
  themeCatalog.map((theme) => [theme.id, theme]),
);
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && themesById.has(value);
}

export function catalogTheme(id: ThemeId) {
  const theme = themesById.get(id);
  if (!theme) throw new Error(`Missing theme settings: ${id}`);
  return theme;
}

export const appearanceStorageKey = (userId: string) =>
  `texfolia.appearance.v2:${userId}`;
export const legacyAppearanceStorageKey = (userId: string) =>
  `texfolia.appearance.v1:${userId}`;

export function resolveTheme(definition: ThemeDefinition) {
  const { id, settings, mode, name } = definition;
  const bg = settings.background;
  const fg = settings.foreground;
  const mix = (amount: number) => `color-mix(in srgb, ${fg} ${amount}%, ${bg})`;
  const surface = mix(4);
  // UIW gutterBorder can be a border shorthand or transparent. Keep workspace boundaries visible.
  const gutterBorder = settings.gutterBorder?.match(/#[\da-f]{3,8}\b/i)?.[0];
  const border = gutterBorder ?? mix(18);
  const accent = mix(12);
  const primary = fg;
  const ring = settings.caret ?? fg;
  const variables = {
    "--background": bg,
    "--foreground": fg,
    "--card": surface,
    "--card-foreground": fg,
    "--popover": surface,
    "--popover-foreground": fg,
    "--primary": primary,
    "--primary-foreground": bg,
    "--secondary": surface,
    "--secondary-foreground": fg,
    "--muted": surface,
    "--muted-foreground": mix(72),
    "--accent": accent,
    "--accent-foreground": fg,
    "--destructive": mode === "dark" ? "#f48771" : "#b42318",
    "--success": mode === "dark" ? "#3fb950" : "#1a7f37",
    "--warning": mode === "dark" ? "#d29922" : "#9a6700",
    "--info": mode === "dark" ? "#58a6ff" : "#0969da",
    // Marks text that has comments, behind the text itself.
    "--highlight": "#f59e0b",
    "--border": border,
    "--input": surface,
    "--input-foreground": fg,
    "--input-placeholder": mix(65),
    "--panel-background": bg,
    "--ring": ring,
    "--sidebar": surface,
    "--sidebar-foreground": fg,
    "--sidebar-primary": primary,
    "--sidebar-primary-foreground": bg,
    "--sidebar-accent": accent,
    "--sidebar-accent-foreground": fg,
    "--sidebar-border": border,
    "--sidebar-ring": ring,
    "--activity-background": surface,
    "--activity-foreground": fg,
    "--status-background": surface,
    "--status-foreground": fg,
    "--tab-active-background": bg,
    "--tab-active-foreground": fg,
    "--tab-inactive-background": surface,
    "--tab-inactive-foreground": mix(72),
    "--tab-border": border,
    "--tab-header": surface,
    "--selection": settings.selection ?? accent,
    "--selection-foreground": fg,
    "--overlay": "rgba(0, 0, 0, 0.1)",
    "--pdf-surround": mix(9),
    "--pdf-original-surround": "#e4e4e7",
    "--pdf-original-foreground": "#242424",
    // Search results, over pages that are white whatever the theme.
    "--pdf-mark": "#ffdf2080",
    "--pdf-mark-current": "#ff690099",
  };
  return { id, name, mode, variables, settings };
}
