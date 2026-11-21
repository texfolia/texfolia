import { expect, test } from "bun:test";

import {
  addPersonalWord,
  personalDictionaryHas,
  personalWord,
} from "#/lib/settings.schema";

test("personal words are normalized and kept sorted without duplicates", () => {
  expect(addPersonalWord(["zeta"], " Texfolia ")).toEqual(["Texfolia", "zeta"]);
  expect(addPersonalWord(["alpha"], "alpha")).toEqual(["alpha"]);
  expect(personalWord("café")).toBe("café");
  expect(personalWord("two words")).toBeUndefined();
  expect(personalWord("\\emph")).toBeUndefined();
});

test("lowercase entries accept capitalized forms only", () => {
  const words = new Set(["texfolia", "LaTeXML"]);
  expect(personalDictionaryHas(words, "Texfolia")).toBe(true);
  expect(personalDictionaryHas(words, "LaTeXML")).toBe(true);
  expect(personalDictionaryHas(words, "latexml")).toBe(false);
});
