import { maskLatexSource, type WordSpan, wordEvents } from "@texfolia/editor";

/** A prose word to spell check, with its range in the source. */
export type ProseWord = { from: number; to: number; word: string };

// Combining marks for LaTeX's text accent commands.
const accents: Record<string, string> = {
  "'": "\u0301",
  "`": "\u0300",
  "^": "\u0302",
  '"': "\u0308",
  "~": "\u0303",
  "=": "\u0304",
  ".": "\u0307",
};
// Arguments that hold keys, paths, units or code rather than prose. Word
// counts keep matching texcount, so these apply to spell checking only.
const ignoredMacros: Record<string, number> = {
  hyperref: 0,
  inputminted: 2,
  lstinputlisting: 1,
  includepdf: 1,
  includesvg: 1,
  import: 2,
  subimport: 2,
  usetikzlibrary: 1,
  tikzset: 1,
  pgfplotsset: 1,
  lstset: 1,
  sisetup: 1,
  captionsetup: 1,
  setlist: 1,
  SI: 2,
  qty: 2,
  si: 1,
  unit: 1,
  num: 1,
  crefrange: 2,
  Crefrange: 2,
  cellcolor: 1,
  rowcolor: 1,
  fontsize: 2,
  newacronym: 2,
  newglossaryentry: 2,
  ...Object.fromEntries(
    [
      "gls",
      "Gls",
      "GLS",
      "glspl",
      "Glspl",
      "glsentrytext",
      "acrshort",
      "acrlong",
      "acrfull",
      "ac",
      "Ac",
      "acs",
      "acl",
      "acf",
      "acp",
      "Acp",
    ].map((name) => [name, 1]),
  ),
};
const accent = /\\(['`^"~=.])\s*(?:\{\s*(\\[ij]|\p{L})\s*\}|(\p{L}))/gu;

/** Turns `caf\'e` or `na\"{\i}ve`-style source into the word it typesets. */
function decode(source: string) {
  return source
    .replace(
      accent,
      (_match, mark: string, braced?: string, bare?: string) =>
        (braced ?? bare ?? "").replace("\\", "") + (accents[mark] ?? ""),
    )
    .replace(/[{}]/g, "")
    .normalize("NFC");
}

/** Whether a word is worth checking: acronyms and numbers are skipped. */
function checkable(word: string) {
  if (word.length < 2 || /\p{N}|\\/u.test(word)) return false;
  return word !== word.toUpperCase() || word === word.toLowerCase();
}

/**
 * Finds the prose words in a LaTeX file. Commands, environment names, math,
 * comments, verbatim material, `\label`, `\ref` and `\cite` arguments and the
 * preamble (except `\title`) are skipped, using the word counter's parser.
 * Hyphenated and dotted runs such as `well-known` are checked part by part.
 */
export function proseWords(text: string): ProseWord[] {
  const masked = maskLatexSource(text);
  const begin = /\\begin\s*\{document\}/.exec(masked);
  const bodyStart = begin ? begin.index + begin[0].length : 0;
  const end = begin ? masked.indexOf("\\end{document}", bodyStart) : -1;
  const bodyEnd = end === -1 ? text.length : end;
  const words: ProseWord[] = [];
  const onWord = ({ from, to, mode, preamble }: WordSpan) => {
    if (mode === "ignore") return;
    if (!preamble && (from < bodyStart || to > bodyEnd)) return;
    // Split on hyphens, dots and braces, but not within accent commands.
    const parts = /(?:\\[^a-zA-Z]\s*(?:\{[^{}]*\})?|[^.{}-])+/gu;
    const span = text.slice(from, to);
    for (const part of span.matchAll(parts)) {
      const word = decode(part[0]);
      if (checkable(word))
        words.push({
          from: from + part.index,
          to: from + part.index + part[0].length,
          word,
        });
    }
  };
  wordEvents(text, { onWord, ignoredMacros });
  return words;
}
