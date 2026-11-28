export type FuzzyMatch = {
  score: number;
  /** The matched characters, as indexes into the text. */
  positions: number[];
};

const isBoundary = (text: string, index: number) => {
  const previous = text[index - 1];
  const character = text[index];
  return (
    previous === undefined ||
    /[\s/_.:-]/.test(previous) ||
    (/\p{Ll}/u.test(previous) && /\p{Lu}/u.test(character ?? ""))
  );
};

const maxLength = 1024;

/**
 * Whether the characters of `query` appear in `text` in order, and how well.
 * Runs of characters, starts of words, and the last path segment count for
 * more. Spaces in the query are ignored.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = [...query.toLowerCase().replace(/\s+/g, "")];
  if (!needle.length) return { score: 0, positions: [] };
  const limited = text.slice(0, maxLength);
  const haystack = limited.toLowerCase();
  // Lower case of a different length would shift every position.
  if (haystack.length !== limited.length) return null;
  const nameStart = limited.lastIndexOf("/") + 1;
  const points = (index: number) =>
    1 + (isBoundary(limited, index) ? 8 : 0) + (index >= nameStart ? 4 : 0);
  // The best score of the query so far that ends at each character.
  let previous: number[] = [];
  const origins: Int32Array[] = [];
  for (const [row, character] of needle.entries()) {
    const scores = Array.from({ length: limited.length }, () => -Infinity);
    const origin = new Int32Array(limited.length).fill(-1);
    let best = -Infinity;
    let bestAt = -1;
    for (let index = 0; index < limited.length; index++) {
      if (haystack.startsWith(character, index)) {
        if (row === 0) scores[index] = points(index);
        else {
          const run = (previous[index - 1] ?? -Infinity) + 10;
          const jump = best - 1;
          const from = Math.max(run, jump);
          if (from > -Infinity) {
            scores[index] = from + points(index);
            origin[index] = run >= jump ? index - 1 : bestAt;
          }
        }
      }
      const before = previous[index] ?? -Infinity;
      if (before > best) {
        best = before;
        bestAt = index;
      }
    }
    origins.push(origin);
    previous = scores;
  }
  let at = -1;
  let score = -Infinity;
  for (const [index, value] of previous.entries())
    if (value > score) {
      score = value;
      at = index;
    }
  if (at < 0) return null;
  const positions: number[] = [];
  for (let row = needle.length - 1; row >= 0; row--) {
    positions.unshift(at);
    at = origins[row]?.[at] ?? -1;
  }
  // Of equal matches, the shorter text is the closer one.
  return { score: score - limited.length / 100, positions };
}

/** The items that match, best first; all of them in order for an empty query. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
) {
  const matches = items.flatMap((item) => {
    const match = fuzzyMatch(query, text(item));
    return match ? [{ item, ...match }] : [];
  });
  return query.trim() ? matches.sort((a, b) => b.score - a.score) : matches;
}
