import { z } from "zod";

import { defaultShortcuts, shortcutMapSchema } from "./shortcuts";
export { projectFormattingSchema as formatSettingsSchema } from "./project.schema";

export const editorSettingsSchema = z.object({
  fontSize: z.number().int().min(10).max(24),
  wrapLines: z.boolean(),
});
export const compileSettingsSchema = z.object({
  onSave: z.boolean(),
});
export const settingsSchema = z.object({
  id: z.literal("preferences"),
  editor: editorSettingsSchema,
  compile: compileSettingsSchema,
  shortcuts: shortcutMapSchema,
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  id: "preferences",
  editor: { fontSize: 13, wrapLines: true },
  compile: { onSave: true },
  shortcuts: defaultShortcuts,
};
