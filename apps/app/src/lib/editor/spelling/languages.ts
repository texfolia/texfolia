import { z } from "zod";

/** A project's spell-check language as a BCP 47 tag, or `off`. */
export const spellingLanguages = [
  "en-US",
  "en-GB",
  "fr",
  "de",
  "es",
  "off",
] as const;
export const spellingLanguageSchema = z.enum(spellingLanguages);
export type SpellingLanguage = z.infer<typeof spellingLanguageSchema>;
export type SpellingDictionary = Exclude<SpellingLanguage, "off">;
export const defaultSpellingLanguage: SpellingLanguage = "en-US";

/**
 * Hunspell dictionaries bundled at launch. `scripts/copy-dictionaries.ts`
 * copies each from its package into `public/dictionaries`, and the spelling
 * worker fetches one only when a project uses it.
 */
export const spellingDictionaries: Record<
  SpellingDictionary,
  { label: string; package: string }
> = {
  "en-US": { label: "English (US)", package: "dictionary-en" },
  "en-GB": { label: "English (UK)", package: "dictionary-en-gb" },
  fr: { label: "French", package: "dictionary-fr" },
  de: { label: "German", package: "dictionary-de" },
  es: { label: "Spanish", package: "dictionary-es" },
};

export const dictionaryPath = (
  language: SpellingDictionary,
  file: "aff" | "dic",
) => `/dictionaries/${language}.${file}`;
