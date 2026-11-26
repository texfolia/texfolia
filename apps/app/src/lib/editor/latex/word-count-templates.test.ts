import { expect, test } from "bun:test";

import { templateStarters } from "@texfolia/db/template-starters";
import { countWords, wordEvents } from "@texfolia/editor";

test("starter templates match texcount totals", () => {
  // Values from `texcount` 3.1.1 (text+headers+captions) on each starter.
  const expected: Record<string, [number, number, number]> = {
    article: [25, 8, 0],
    journal: [23, 7, 0],
    thesis: [23, 8, 0],
  };
  for (const starter of templateStarters) {
    const words = countWords(
      new Map([["main.tex", wordEvents(starter.source)]]),
      "main.tex",
    );
    const reference = expected[starter.slug];
    if (!reference) continue;
    expect([words.text, words.headers, words.captions]).toEqual(reference);
  }
});
