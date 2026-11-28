import { LruCache } from "#/lib/lru-cache";
import { createWorkerClient } from "#/lib/worker-client";

import type { SpellingDictionary } from "./languages";

export type SpellRequest =
  | {
      id: number;
      type: "check";
      language: SpellingDictionary;
      words: string[];
    }
  | { id: number; type: "suggest"; language: SpellingDictionary; word: string };

export type SpellResponse =
  | { id: number; misspelled: string[] }
  | { id: number; suggestions: string[] }
  | { id: number; error: string };

// Enough for the vocabulary of a large project, per language.
const maxVerdicts = 50_000;
const maxSuggestions = 500;

export type SpellChecker = {
  /** Resolves to the words that are not in the dictionary. */
  check(language: SpellingDictionary, words: string[]): Promise<Set<string>>;
  suggest(language: SpellingDictionary, word: string): Promise<string[]>;
};

/**
 * Talks to a spelling worker and remembers recent words' verdicts per
 * language, so a lint pass mostly sends only words it has not seen before.
 */
export function createSpellChecker(
  createWorker: () => Worker,
  limits = { verdicts: maxVerdicts, suggestions: maxSuggestions },
): SpellChecker {
  const request = createWorkerClient<SpellRequest, SpellResponse>(
    createWorker,
    "The spell checker failed to start.",
  );
  const verdicts = new Map<SpellingDictionary, LruCache<string, boolean>>();
  const suggestions = new LruCache<string, Promise<string[]>>(
    limits.suggestions,
  );

  return {
    async check(language, words) {
      let known = verdicts.get(language);
      if (!known)
        verdicts.set(language, (known = new LruCache(limits.verdicts)));
      // Collected here, as remembering new words may evict older ones.
      const misspelled = new Set<string>();
      const unknown: string[] = [];
      for (const word of new Set(words)) {
        const correct = known.get(word);
        if (correct === undefined) unknown.push(word);
        else if (!correct) misspelled.add(word);
      }
      if (unknown.length) {
        const response = await request({
          type: "check",
          language,
          words: unknown,
        });
        if ("error" in response) throw new Error(response.error);
        if (!("misspelled" in response)) return new Set();
        const wrong = new Set(response.misspelled);
        for (const word of unknown) {
          known.set(word, !wrong.has(word));
          if (wrong.has(word)) misspelled.add(word);
        }
      }
      return misspelled;
    },
    suggest(language, word) {
      const key = `${language}\u0000${word}`;
      let result = suggestions.get(key);
      if (!result) {
        result = request({ type: "suggest", language, word }).then(
          (response) => {
            if ("error" in response) throw new Error(response.error);
            return "suggestions" in response ? response.suggestions : [];
          },
        );
        result.catch(() => suggestions.delete(key));
        suggestions.set(key, result);
      }
      return result;
    },
  };
}

let shared: SpellChecker | undefined;

/** The browser's spell checker, which starts its worker on first use. */
export function browserSpellChecker() {
  shared ??= createSpellChecker(
    () =>
      new Worker(new URL("./spelling.worker.ts", import.meta.url), {
        type: "module",
      }),
  );
  return shared;
}
