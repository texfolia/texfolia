/** A run of text on a page, as PDF.js reports it. */
export type TextItem = {
  str: string;
  hasEOL: boolean;
  /** Where it starts, as fractions of the page without rotation. */
  x: number;
  y: number;
};

/** Part of one item of a page. */
export type TextRange = { item: number; from: number; to: number };
export type PdfMatch = {
  page: number;
  x: number;
  y: number;
  ranges: TextRange[];
};

/** A page's text, and the item and offset that each character came from. */
export type PageText = {
  page: number;
  items: readonly TextItem[];
  text: string;
  sources: { item: number; offset: number }[];
};

const isSpace = (character: string) => /\s/.test(character);

/**
 * Joins a page's items into text that can be searched: lower case, with single
 * spaces, and without the hyphens that break a word over two lines.
 */
export function pageText(page: number, items: readonly TextItem[]): PageText {
  let text = "";
  const sources: PageText["sources"] = [];
  const add = (character: string, item: number, offset: number) => {
    if (isSpace(character)) {
      if (!text || text.endsWith(" ")) return;
      character = " ";
    }
    // Lower case can be longer, as in İ. Each character maps to one source.
    const lower = character.toLowerCase();
    text += lower;
    for (let index = 0; index < lower.length; index++)
      sources.push({ item, offset });
  };
  for (const [item, { str, hasEOL }] of items.entries()) {
    for (let offset = 0; offset < str.length; offset++)
      add(str[offset] ?? "", item, offset);
    if (!hasEOL) continue;
    const next = items.slice(item + 1).find(({ str }) => str)?.str[0] ?? "";
    if (/[\p{L}][-‐­]$/u.test(text) && /\p{Ll}/u.test(next)) {
      text = text.slice(0, -1);
      sources.pop();
    } else add(" ", item, Math.max(0, str.length - 1));
  }
  return { page, items, text, sources };
}

/** Where `query` is on a page. Matches do not overlap. */
export function findInPage(page: PageText, query: string): PdfMatch[] {
  const needle = query.toLowerCase().replace(/\s+/g, " ").trim();
  const matches: PdfMatch[] = [];
  if (!needle) return matches;
  for (
    let at = page.text.indexOf(needle);
    at >= 0;
    at = page.text.indexOf(needle, at + needle.length)
  ) {
    const ranges: TextRange[] = [];
    for (const { item, offset } of page.sources.slice(at, at + needle.length)) {
      const last = ranges.at(-1);
      if (last?.item === item) last.to = offset + 1;
      else ranges.push({ item, from: offset, to: offset + 1 });
    }
    const start = page.items[ranges[0]?.item ?? 0];
    matches.push({
      page: page.page,
      x: start?.x ?? 0,
      y: start?.y ?? 0,
      ranges,
    });
  }
  return matches;
}

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
const escape = (text: string) =>
  text.replace(/[&<>"]/g, (character) => entities[character] ?? character);

/** An item's text as HTML, with its matches marked. */
export function markItem(
  str: string,
  ranges: readonly { from: number; to: number; current: boolean }[],
) {
  let html = "";
  let at = 0;
  for (const { from, to, current } of ranges) {
    html += escape(str.slice(at, from));
    html += `<mark${current ? ' data-current="true"' : ""}>${escape(str.slice(from, to))}</mark>`;
    at = to;
  }
  return html + escape(str.slice(at));
}
