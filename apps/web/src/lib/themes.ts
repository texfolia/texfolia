import * as themes from "@uiw/codemirror-themes-all";
import { EditorState, EditorView } from "@uiw/react-codemirror";
import { z } from "zod";

type Exports = typeof themes;
export type ThemeId = {
  [K in keyof Exports]: K extends `${string}Init`
    ? K extends `${infer Id}Init`
      ? Id
      : never
    : never;
}[keyof Exports];

export function isThemeId(value: unknown): value is ThemeId {
  return (
    typeof value === "string" &&
    Object.hasOwn(themes, value) &&
    Object.hasOwn(themes, `${value}Init`)
  );
}
export const themeIdSchema = z.custom<ThemeId>(isThemeId);

const settingsSchema = z.object({
  background: z.string(),
  foreground: z.string(),
  caret: z.string().optional(),
  selection: z.string().optional(),
  selectionMatch: z.string().optional(),
  lineHighlight: z.string().optional(),
  gutterBackground: z.string().optional(),
  gutterForeground: z.string().optional(),
  gutterActiveForeground: z.string().optional(),
  gutterBorder: z.string().optional(),
});

export const themeCatalog = Object.entries(themes)
  .flatMap(([key, value]) => {
    if (!key.startsWith("defaultSettings")) return [];
    const suffix = key.slice("defaultSettings".length);
    const id = suffix.charAt(0).toLowerCase() + suffix.slice(1);
    if (!isThemeId(id)) throw new Error(`Missing UIW theme extension: ${id}`);
    const extension = themes[id];
    const mode = EditorState.create({ extensions: [extension] }).facet(
      EditorView.darkTheme,
    )
      ? "dark"
      : "light";
    return [
      {
        id,
        name: suffix
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/^Github/, "GitHub")
          .replace(/^Vscode/, "VS Code"),
        mode,
        settings: settingsSchema.parse(value),
        extension,
      },
    ];
  })
  .sort((a, b) => a.name.localeCompare(b.name));
export type ThemeDefinition = (typeof themeCatalog)[number];

export function catalogTheme(id: ThemeId) {
  const theme = themeCatalog.find((theme) => theme.id === id);
  if (!theme) throw new Error(`Missing UIW theme settings: ${id}`);
  return theme;
}

export const appearanceSchema = z.object({
  selection: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("system") }),
    z.object({ kind: z.literal("theme"), id: themeIdSchema }),
  ]),
  pdfMode: z.enum(["original", "match"]).default("original"),
});
export type Appearance = z.infer<typeof appearanceSchema>;
export const defaultAppearance: Appearance = {
  selection: { kind: "system" },
  pdfMode: "original",
};
export const appearanceStorageKey = (userId: string) =>
  `texfolia.appearance.v2:${userId}`;
export const legacyAppearanceStorageKey = (userId: string) =>
  `texfolia.appearance.v1:${userId}`;

export function migrateAppearance(value: unknown): Appearance {
  const saved = z
    .object({
      selection: z.unknown(),
      pdfMode: appearanceSchema.shape.pdfMode,
    })
    .safeParse(value);
  if (!saved.success) return defaultAppearance;
  const current = appearanceSchema.shape.selection.safeParse(
    saved.data.selection,
  );
  if (current.success) return { ...saved.data, selection: current.data };
  const legacy = z
    .object({ kind: z.literal("bundled"), id: themeIdSchema })
    .safeParse(saved.data.selection);
  return {
    pdfMode: saved.data.pdfMode,
    selection: legacy.success
      ? { kind: "theme", id: legacy.data.id }
      : defaultAppearance.selection,
  };
}

export function selectedTheme(appearance: Appearance, dark: boolean) {
  return catalogTheme(
    appearance.selection.kind === "system"
      ? dark
        ? "githubDark"
        : "githubLight"
      : appearance.selection.id,
  );
}

export function resolveTheme(definition: ThemeDefinition) {
  const { settings, mode, name, extension } = definition;
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
    "--overlay": "#00000066",
    "--pdf-surround": mix(9),
    "--pdf-original-surround": "#e4e4e7",
    "--pdf-original-foreground": "#242424",
  };
  return { name, mode, variables, settings, extension };
}
