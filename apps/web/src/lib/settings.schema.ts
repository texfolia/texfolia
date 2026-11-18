import { z } from "zod";

import { defaultShortcuts, shortcutMapSchema } from "./shortcuts";
export { projectFormattingSchema as formatSettingsSchema } from "./project.schema";

export const editorSettingsSchema = z.object({
  fontSize: z.number().int().min(10).max(24),
  wrapLines: z.boolean(),
});
export const autoCompileDelays = [0, 1, 2, 5] as const;
export type AutoCompileDelay = (typeof autoCompileDelays)[number];
export const compileSettingsSchema = z.object({
  onSave: z.boolean(),
  /** Seconds of editing inactivity before saving and compiling; 0 is off. */
  afterIdle: z.literal(autoCompileDelays).default(0),
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
  compile: { onSave: true, afterIdle: 0 },
  shortcuts: defaultShortcuts,
};
