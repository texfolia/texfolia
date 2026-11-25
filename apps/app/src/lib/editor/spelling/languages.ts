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
 * worker fetches one only when a project uses it. Browsers keep a dictionary
 * forever, so its URL has the package's version; a test keeps the two equal.
 */
export const spellingDictionaries: Record<
  SpellingDictionary,
  { label: string; package: string; version: string }
> = {
  "en-US": {
    label: "English (US)",
    package: "dictionary-en",
    version: "4.0.0",
  },
  "en-GB": {
    label: "English (UK)",
    package: "dictionary-en-gb",
    version: "3.0.0",
  },
  fr: { label: "French", package: "dictionary-fr", version: "3.0.0" },
  de: { label: "German", package: "dictionary-de", version: "3.0.0" },
  es: { label: "Spanish", package: "dictionary-es", version: "4.0.0" },
};

export const dictionaryPath = (
  language: SpellingDictionary,
  file: "aff" | "dic",
) => `/dictionaries/${language}.${file}`;

export const dictionaryUrl = (
  language: SpellingDictionary,
  file: "aff" | "dic",
) =>
  `${dictionaryPath(language, file)}?v=${spellingDictionaries[language].version}`;
