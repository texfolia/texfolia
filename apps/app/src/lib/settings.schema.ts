import { editorKeymaps } from "@texfolia/editor/keymaps/keymaps";
import { z } from "zod";

import { defaultShortcuts, shortcutMapSchema } from "./shortcuts";
export { projectFormattingSchema as formatSettingsSchema } from "./project.schema";

export const editorSettingsSchema = z.object({
  fontSize: z.number().int().min(10).max(24),
  wrapLines: z.boolean(),
  keymap: z.enum(editorKeymaps).default("default"),
});
export const autoCompileDelays = [0, 1, 2, 5] as const;
export type AutoCompileDelay = (typeof autoCompileDelays)[number];
export const compileSettingsSchema = z.object({
  onSave: z.boolean(),
  /** Seconds of editing inactivity before saving and compiling; 0 is off. */
  afterIdle: z.literal(autoCompileDelays).default(0),
});
const personalWordPattern = /^[^\s\\{}$%]{1,64}$/u;
export const maxPersonalWords = 5000;
export const spellingSettingsSchema = z.object({
  /** The personal dictionary, shared by every project in this browser. */
  words: z.array(z.string().regex(personalWordPattern)).max(maxPersonalWords),
});

/** Normalizes a word for the personal dictionary, or returns undefined. */
export function personalWord(word: string) {
  const normalized = word.normalize("NFC").trim();
  return personalWordPattern.test(normalized) ? normalized : undefined;
}

/** Adds a word to a sorted personal dictionary. */
export function addPersonalWord(words: readonly string[], word: string) {
  const next = personalWord(word);
  if (!next || words.includes(next) || words.length >= maxPersonalWords)
    return [...words];
  return [...words, next].sort((a, b) => a.localeCompare(b));
}

export const settingsSchema = z.object({
  id: z.literal("preferences"),
  editor: editorSettingsSchema,
  compile: compileSettingsSchema,
  shortcuts: shortcutMapSchema,
  spelling: spellingSettingsSchema.default({ words: [] }),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  id: "preferences",
  editor: { fontSize: 13, wrapLines: true, keymap: "default" },
  compile: { onSave: true, afterIdle: 0 },
  shortcuts: defaultShortcuts,
  spelling: { words: [] },
};

/**
 * Whether the personal dictionary accepts a word. Lowercase entries also
 * accept capitalized and uppercase forms, like Hunspell's own dictionaries.
 */
export function personalDictionaryHas(
  words: ReadonlySet<string>,
  word: string,
) {
  return words.has(word) || words.has(word.toLowerCase());
}
