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

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

export type SpellChecker = {
  /** Resolves to the words that are not in the dictionary. */
  check(language: SpellingDictionary, words: string[]): Promise<Set<string>>;
  suggest(language: SpellingDictionary, word: string): Promise<string[]>;
};

/**
 * Talks to a spelling worker and remembers each word's verdict per language,
 * so a lint pass only sends words it has not seen before.
 */
export function createSpellChecker(createWorker: () => Worker): SpellChecker {
  let worker: Worker | undefined;
  let nextId = 0;
  const pending = new Map<number, (response: SpellResponse) => void>();
  const verdicts = new Map<SpellingDictionary, Map<string, boolean>>();
  const suggestions = new Map<string, Promise<string[]>>();

  function request(message: WithoutId<SpellRequest>) {
    if (!worker) {
      worker = createWorker();
      worker.onmessage = ({ data }: MessageEvent<SpellResponse>) => {
        pending.get(data.id)?.(data);
        pending.delete(data.id);
      };
      worker.onerror = () => {
        for (const [id, resolve] of pending)
          resolve({ id, error: "The spell checker failed to start." });
        pending.clear();
        worker = undefined;
      };
    }
    const id = ++nextId;
    const target = worker;
    return new Promise<SpellResponse>((resolve) => {
      pending.set(id, resolve);
      target.postMessage({ ...message, id } as SpellRequest);
    });
  }

  return {
    async check(language, words) {
      let known = verdicts.get(language);
      if (!known) verdicts.set(language, (known = new Map()));
      const unknown = [...new Set(words)].filter((word) => !known.has(word));
      if (unknown.length) {
        const response = await request({
          type: "check",
          language,
          words: unknown,
        });
        if ("error" in response) throw new Error(response.error);
        if (!("misspelled" in response)) return new Set();
        const wrong = new Set(response.misspelled);
        for (const word of unknown) known.set(word, !wrong.has(word));
      }
      return new Set(words.filter((word) => known.get(word) === false));
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
