import { z } from "zod";

import { catalogTheme, isThemeId, type ThemeId } from "./themes";

const themeIdSchema = z.custom<ThemeId>(isThemeId);

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
