import nspell from "nspell";

import type { SpellRequest, SpellResponse } from "./checker";
import { dictionaryUrl, type SpellingDictionary } from "./languages";

type Speller = ReturnType<typeof nspell>;
const spellers = new Map<SpellingDictionary, Promise<Speller>>();

async function fetchText(path: string) {
  const response = await fetch(new URL(path, self.location.origin));
  if (!response.ok)
    throw new Error(`Dictionary request failed (${response.status}).`);
  return response.text();
}

// Dictionaries load on first use and stay in memory for the worker's life.
function speller(language: SpellingDictionary) {
  let loaded = spellers.get(language);
  if (!loaded) {
    loaded = Promise.all([
      fetchText(dictionaryUrl(language, "aff")),
      fetchText(dictionaryUrl(language, "dic")),
    ]).then(([aff, dic]) => nspell(aff, dic));
    loaded.catch(() => spellers.delete(language));
    spellers.set(language, loaded);
  }
  return loaded;
}

const correct = (spell: Speller, word: string) =>
  spell.correct(word) || spell.correct(word.replaceAll("’", "'"));

self.onmessage = async ({ data }: MessageEvent<SpellRequest>) => {
  let response: SpellResponse;
  try {
    const spell = await speller(data.language);
    response =
      data.type === "check"
        ? {
            id: data.id,
            misspelled: data.words.filter((word) => !correct(spell, word)),
          }
        : {
            id: data.id,
            suggestions: spell.suggest(data.word.replaceAll("’", "'")),
          };
  } catch (cause) {
    response = {
      id: data.id,
      error:
        cause instanceof Error ? cause.message : "Dictionary failed to load.",
    };
  }
  self.postMessage(response);
};
