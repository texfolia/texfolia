import { z } from "zod";

import { defaultFormatSettings } from "#/lib/latex/format";

export const editorSettingsSchema = z.object({
  fontSize: z.number().int().min(10).max(24),
  wrapLines: z.boolean(),
});
export const formatSettingsSchema = z.object({
  indent: z.number().int().min(1).max(8),
  wrap: z.boolean(),
  width: z.number().int().min(40).max(200),
});
export const settingsSchema = z.object({
  id: z.literal("preferences"),
  editor: editorSettingsSchema,
  formatting: formatSettingsSchema,
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  id: "preferences",
  editor: { fontSize: 13, wrapLines: true },
  formatting: defaultFormatSettings,
};
