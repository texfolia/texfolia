import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { debounce } from "#/lib/debounce";
import { mapLimit } from "#/lib/map-limit";
import {
  findInPage,
  pageText,
  type PageText,
  type PdfMatch,
} from "#/lib/pdf/search";

const queryDelayMs = 150;
const readConcurrency = 4;

async function readPages(pdf: PDFDocumentProxy, signal: AbortSignal) {
  return mapLimit(
    Array.from({ length: pdf.numPages }, (_, index) => index + 1),
    readConcurrency,
    async (number): Promise<PageText> => {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      return pageText(
        number,
        content.items.map((item) => {
          // Marked content has no text, but keeps the numbering of the items.
          if (!("str" in item)) return { str: "", hasEOL: false, x: 0, y: 0 };
          const [x, y] = viewport.convertToViewportPoint(
            Number(item.transform[4]),
            Number(item.transform[5]),
          );
          return {
            str: item.str,
            hasEOL: item.hasEOL,
            x: Number(x) / viewport.width,
            y: Number(y) / viewport.height,
          };
        }),
      );
    },
  );
}

type State = {
  pdf: PDFDocumentProxy;
  query: string;
  matches: PdfMatch[];
  failed: boolean;
};

/**
 * Searches a PDF's text while the search is open. A new version of the PDF is
 * searched again, and keeps the position among the matches.
 */
export function usePdfSearch({
  pdf,
  open,
  onShow,
}: {
  pdf: PDFDocumentProxy | undefined;
  open: boolean;
  onShow: (match: PdfMatch) => void;
}) {
  const [query, setQueryState] = useState("");
  const [applied, setApplied] = useState("");
  const [state, setState] = useState<State>();
  const [current, setCurrent] = useState(0);
  const pages = useRef<{ pdf: PDFDocumentProxy; pages: PageText[] }>(null);
  const [apply] = useState(() => debounce(setApplied, queryDelayMs));
  const show = useRef(onShow);
  show.current = onShow;
  useEffect(() => apply.cancel, [apply]);
  const setQuery = useCallback(
    (value: string) => {
      setQueryState(value);
      apply.schedule(value);
    },
    [apply],
  );

  useEffect(() => {
    if (!pdf || !open || !applied.trim()) return;
    const abort = new AbortController();
    void (async () => {
      let matches: PdfMatch[] = [];
      let failed = false;
      try {
        const read =
          pages.current?.pdf === pdf
            ? pages.current.pages
            : await readPages(pdf, abort.signal);
        pages.current = { pdf, pages: read };
        matches = read.flatMap((page) => findInPage(page, applied));
      } catch (error) {
        failed = true;
        if (!abort.signal.aborted)
          console.error("The PDF could not be searched", error);
      }
      if (abort.signal.aborted) return;
      setState((previous) => {
        // Another version of the document must not move the reader.
        const first = previous?.query === applied ? undefined : matches[0];
        if (first) {
          setCurrent(0);
          show.current(first);
        } else
          setCurrent((index) =>
            Math.max(0, Math.min(index, matches.length - 1)),
          );
        return { pdf, query: applied, matches, failed };
      });
    })();
    return () => abort.abort();
  }, [pdf, open, applied]);

  const active = open && !!applied.trim();
  const found = active && state?.query === applied ? state : undefined;
  const matches = useMemo(() => found?.matches ?? [], [found]);
  const byPage = useMemo(() => {
    const result = new Map<
      number,
      Map<number, { from: number; to: number; match: number }[]>
    >();
    for (const [match, { page, ranges }] of matches.entries()) {
      const items = result.get(page) ?? new Map();
      for (const { item, from, to } of ranges)
        items.set(item, [...(items.get(item) ?? []), { from, to, match }]);
      result.set(page, items);
    }
    return result;
  }, [matches]);

  function step(direction: number) {
    if (!matches.length) return;
    const next = (current + direction + matches.length) % matches.length;
    setCurrent(next);
    const match = matches[next];
    if (match) show.current(match);
  }
  return {
    query,
    setQuery,
    step,
    current,
    matches,
    /** Marked ranges by page number and then by item. */
    byPage: found?.pdf === pdf ? byPage : undefined,
    status: !active
      ? ""
      : !found
        ? "Searching…"
        : found.failed
          ? "Search failed"
          : matches.length
            ? `${current + 1} of ${matches.length}`
            : "No results",
  };
}
