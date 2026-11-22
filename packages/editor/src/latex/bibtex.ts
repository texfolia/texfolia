// Helpers for adding references to BibTeX files: recognizing the identifiers
// people paste, and placing a fetched entry in a .bib file.

export type ReferenceId =
  | { kind: "doi"; id: string }
  | { kind: "arxiv"; id: string }
  | { kind: "isbn"; id: string };

const doiPattern = /^10\.\d{4,9}\/\S+$/;
// New-style IDs (2007 onward) and old-style archive/number IDs.
const arxivPattern =
  /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;

function isbnValid(digits: string) {
  if (digits.length === 10) {
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const char = digits[i] ?? "";
      const value = char === "X" ? 10 : Number(char);
      if (char === "X" && i !== 9) return false;
      sum += value * (10 - i);
    }
    return sum % 11 === 0;
  }
  if (digits.length !== 13 || !/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(digits[i]) * (i % 2 ? 3 : 1);
  return sum % 10 === 0;
}

function decodeDoi(doi: string) {
  try {
    return decodeURIComponent(doi);
  } catch {
    return doi;
  }
}

/** Recognizes a DOI, arXiv ID or ISBN, including the usual URL forms. */
export function parseReferenceId(input: string): ReferenceId | null {
  let value = input.trim();
  if (!value) return null;

  const doi = value
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  if (doiPattern.test(doi)) {
    // arXiv's DataCite DOIs are looked up the same way as other DOIs, but
    // reporting them as arXiv IDs keeps the generated entry an e-print.
    const arxiv = /^10\.48550\/arxiv\.(.+)$/i.exec(doi)?.[1];
    if (arxiv && arxivPattern.test(arxiv)) return { kind: "arxiv", id: arxiv };
    return { kind: "doi", id: decodeDoi(doi) };
  }

  value = value
    .replace(
      /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\//i,
      "",
    )
    .replace(/\.pdf$/i, "")
    .replace(/^arxiv:\s*/i, "");
  if (arxivPattern.test(value)) return { kind: "arxiv", id: value };

  const isbn = value
    .replace(/^isbn(?:-1[03])?:?\s*/i, "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
  if (/^(?:\d{9}[\dX]|\d{13})$/.test(isbn) && isbnValid(isbn))
    return { kind: "isbn", id: isbn };
  return null;
}

export type BibEntryKey = { key: string; from: number; to: number };

/** Entry keys in a .bib source, skipping @comment, @string and @preamble. */
export function bibEntryKeys(source: string): BibEntryKey[] {
  const keys: BibEntryKey[] = [];
  for (const match of source.matchAll(
    /@([a-z]+)\s*[{(]\s*([^\s,{}()]+)\s*,/gi,
  )) {
    const [, type, key] = match;
    if (!type || !key || /^(?:comment|string|preamble)$/i.test(type)) continue;
    const from = match.index + match[0].lastIndexOf(key);
    keys.push({ key, from, to: from + key.length });
  }
  return keys;
}

/** Replaces the key of the first entry in `entry`. */
export function setEntryKey(entry: string, key: string) {
  const [first] = bibEntryKeys(entry);
  return first
    ? entry.slice(0, first.from) + key + entry.slice(first.to)
    : entry;
}

/**
 * BibTeX and Biber treat keys that differ only in case as the same entry, so
 * uniqueness is checked without case.
 */
export function uniqueEntryKey(key: string, existing: Iterable<string>) {
  const taken = new Set([...existing].map((value) => value.toLowerCase()));
  if (!taken.has(key.toLowerCase())) return key;
  for (let i = 0; ; i++) {
    // a…z, then aa…zz, as reference managers do.
    let suffix = "";
    for (let n = i; n >= 0; n = Math.floor(n / 26) - 1)
      suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    const candidate = key + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The text to insert at the end of `source` so `entry` follows a blank line. */
export function entryAppendix(source: string, entry: string) {
  const body = entry.trim() + "\n";
  if (!source.trim()) return body;
  const trailing = /\n*$/.exec(source)?.[0].length ?? 0;
  return "\n".repeat(Math.max(0, 2 - trailing)) + body;
}

/** A valid key is non-empty and free of BibTeX's separators. */
export function validEntryKey(key: string) {
  return /^[^\s,{}()"#%'=\\~]+$/.test(key);
}

function editDistance(a: string, b: string, limit: number) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let before: number[] = [];
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      // Adjacent transpositions count as one edit, the usual typo.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, (before[j - 2] ?? 0) + 1);
      current[j] = value;
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/** Defined keys close enough to `key` to be the one meant, best first. */
export function similarKeys(
  key: string,
  keys: readonly string[],
  count = 3,
): string[] {
  const lower = key.toLowerCase();
  const limit = Math.max(1, Math.floor(key.length / 4));
  return keys
    .flatMap((candidate) => {
      const distance =
        candidate.toLowerCase() === lower
          ? 0
          : editDistance(lower, candidate.toLowerCase(), limit);
      return distance <= limit ? [{ candidate, distance }] : [];
    })
    .sort(
      (a, b) =>
        a.distance - b.distance || a.candidate.localeCompare(b.candidate),
    )
    .slice(0, count)
    .map(({ candidate }) => candidate);
}
