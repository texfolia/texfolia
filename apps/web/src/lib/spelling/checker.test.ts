import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import nspell from "nspell";

import {
  createSpellChecker,
  type SpellRequest,
  type SpellResponse,
} from "./checker";

const dictionary = (file: string) =>
  readFileSync(new URL(file, import.meta.resolve("dictionary-en")), "utf8");

// Answers like the spelling worker, with the real en-US dictionary.
function fakeWorker(requests: SpellRequest[], fail = false) {
  const spell = nspell(dictionary("index.aff"), dictionary("index.dic"));
  const worker = {
    onmessage: null as ((event: { data: SpellResponse }) => void) | null,
    onerror: null as (() => void) | null,
    postMessage(data: SpellRequest) {
      requests.push(data);
      queueMicrotask(() => {
        if (fail) return worker.onerror?.();
        worker.onmessage?.({
          data:
            data.type === "check"
              ? {
                  id: data.id,
                  misspelled: data.words.filter((word) => !spell.correct(word)),
                }
              : { id: data.id, suggestions: spell.suggest(data.word) },
        });
      });
    },
  };
  return worker as unknown as Worker;
}

test("reports misspelled words and only sends unseen words", async () => {
  const requests: SpellRequest[] = [];
  const checker = createSpellChecker(() => fakeWorker(requests));
  expect(
    await checker.check("en-US", ["The", "recieve", "color", "teh"]),
  ).toEqual(new Set(["recieve", "teh"]));
  expect(await checker.check("en-US", ["recieve", "color", "colour"])).toEqual(
    new Set(["recieve", "colour"]),
  );
  expect(
    requests.map((request) => request.type === "check" && request.words),
  ).toEqual([["The", "recieve", "color", "teh"], ["colour"]]);
  expect(await checker.check("en-US", ["color"])).toEqual(new Set());
  expect(requests).toHaveLength(2);
});

test("suggests corrections once per word", async () => {
  const requests: SpellRequest[] = [];
  const checker = createSpellChecker(() => fakeWorker(requests));
  expect(await checker.suggest("en-US", "recieve")).toContain("receive");
  await checker.suggest("en-US", "recieve");
  expect(requests).toHaveLength(1);
});

test("a worker failure rejects pending checks and restarts on retry", async () => {
  let fail = true;
  let started = 0;
  const checker = createSpellChecker(() => {
    started++;
    return fakeWorker([], fail);
  });
  await expect(checker.check("en-US", ["word"])).rejects.toThrow(
    "The spell checker failed to start.",
  );
  fail = false;
  expect(await checker.check("en-US", ["word"])).toEqual(new Set());
  expect(started).toBe(2);
});
