import {
  type ComponentProps,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Document } from "react-pdf";

import { useStableCallback } from "#/hooks/use-stable-callback";
import { useWheelZoom } from "#/hooks/use-wheel-zoom";
import { debounce } from "#/lib/debounce";
import { rotatePdfPoint } from "#/lib/editor/latex/synctex";
import {
  anchorAt,
  currentPage,
  layoutPages,
  pageGap,
  type PageSize,
  rotatedSize,
  type ScrollAnchor,
  scrollTo,
  visiblePages,
} from "#/lib/pdf/layout";
import { stepZoom, wheelZoom } from "#/lib/zoom";

import type { PdfVersion } from "./use-pdf-versions";

// Each scale draws the pages again, so a drag or zoom draws them once at the end.
const resizeDelayMs = 150;
const drawDelayMs = 150;
const zoomBounds = { min: 0.25, max: 3 };
export const pdfFits = [
  { value: "width", label: "Fit to width" },
  { value: "page", label: "Fit to page" },
] as const;
type Zoom = (typeof pdfFits)[number]["value"] | number;
type DocumentProps = ComponentProps<typeof Document>;
/** The page indexes that show, and the one the reader is on. */
export type VisiblePages = { first: number; last: number; current: number };

const unknownSize: PageSize = { width: 612, height: 792, rotation: 0 };

/** How far down a link leads, if it names a place and not just a page. */
function destinationTop(dest: unknown) {
  if (!Array.isArray(dest)) return null;
  const [, fit, ...place] = dest as unknown[];
  const name =
    fit && typeof fit === "object" && "name" in fit ? fit.name : undefined;
  const top =
    name === "XYZ"
      ? place[1]
      : name === "FitH" || name === "FitBH"
        ? place[0]
        : null;
  return typeof top === "number" ? top : null;
}

/** Where the reader is in the document, at which zoom and rotation. */
export function usePdfView({
  viewport,
  front,
  setVisible,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  front: PdfVersion | undefined;
  setVisible: (update: (previous: VisiblePages) => VisiblePages) => void;
}) {
  const shown = front?.ready;
  const pages = shown?.sizes.length ?? 0;
  const [area, setArea] = useState({ width: 600, height: 800 });
  const [zoom, setZoom] = useState<Zoom>("width");
  const [rotation, setRotation] = useState(0);
  const firstSize = rotatedSize(shown?.sizes[0] ?? unknownSize, rotation);
  const fitWidth = Math.max(1, area.width - pageGap * 2) / firstSize.width;
  const scale =
    typeof zoom === "number"
      ? zoom
      : zoom === "width"
        ? fitWidth
        : Math.min(
            fitWidth,
            Math.max(1, area.height - pageGap * 2) / firstSize.height,
          );
  const [drawn, setDrawn] = useState({ version: front?.id, scale });
  if (drawn.version !== front?.id) setDrawn({ version: front?.id, scale });
  useEffect(() => {
    if (drawn.scale === scale) return;
    const timer = setTimeout(
      () => setDrawn((previous) => ({ ...previous, scale })),
      drawDelayMs,
    );
    return () => clearTimeout(timer);
  }, [drawn, scale]);
  const layout = useMemo(
    () => layoutPages(shown?.sizes ?? [], scale, rotation),
    [shown?.sizes, scale, rotation],
  );

  // Where the reader is, kept while anything about the layout changes.
  const anchor = useRef<ScrollAnchor>(null);
  // The page that was asked for. The end of a document may not scroll that far.
  const requested = useRef<{ page: number; top: number }>(null);
  // Dockview takes a hidden tab out of the page, which forgets its scroll position.
  const hidden = useRef(false);

  function measure() {
    const element = viewport.current;
    if (!element || !pages) return;
    const { first, last } = visiblePages(
      layout,
      element.scrollTop,
      element.clientHeight,
    );
    if (
      requested.current &&
      Math.abs(requested.current.top - element.scrollTop) > 2
    )
      requested.current = null;
    const next = {
      first,
      last,
      current:
        requested.current?.page ??
        currentPage(layout, element.scrollTop, element.clientHeight),
    };
    setVisible((previous) =>
      previous.first === next.first &&
      previous.last === next.last &&
      previous.current === next.current
        ? previous
        : next,
    );
  }
  function restore() {
    const element = viewport.current;
    if (hidden.current) return;
    const scroll =
      element && anchor.current
        ? scrollTo(layout, element.scrollWidth, anchor.current)
        : null;
    if (scroll) element?.scrollTo(scroll);
    measure();
  }
  function keepPlace(viewX: number, viewY: number) {
    const element = viewport.current;
    if (element && !hidden.current)
      anchor.current = anchorAt(
        layout,
        element.scrollWidth,
        { top: element.scrollTop, left: element.scrollLeft },
        { viewX, viewY },
      );
  }
  function scrolled() {
    if (hidden.current) return;
    keepPlace((viewport.current?.clientWidth ?? 0) / 2, 0);
    measure();
  }
  const layoutChanged = useStableCallback(restore);
  useLayoutEffect(() => layoutChanged(), [layout, area, layoutChanged]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resized = debounce(
      (next: { width: number; height: number }) => setArea(next),
      resizeDelayMs,
    );
    let measured = false;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry?.contentRect ?? { width: 0, height: 0 };
      // A hidden tab keeps its pages for when it is shown.
      if (!width) {
        hidden.current = true;
        resized.cancel();
        return;
      }
      if (hidden.current) {
        hidden.current = false;
        layoutChanged();
      }
      if (measured) resized.schedule({ width, height });
      else setArea({ width, height });
      measured = true;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      resized.cancel();
    };
  }, [viewport, layoutChanged]);

  function scrollToTop(top: number, page: number, left?: number) {
    const element = viewport.current;
    if (!element) return;
    element.scrollTo({ top, ...(left === undefined ? {} : { left }) });
    requested.current = { page, top: element.scrollTop };
    // The scroll event comes later; a new version may change the layout first.
    keepPlace(element.clientWidth / 2, 0);
    measure();
  }
  function goToPage(next: number) {
    const bounded = Math.min(pages, Math.max(1, Math.trunc(next)));
    const box = layout.boxes[bounded - 1];
    if (Number.isFinite(bounded) && box)
      scrollToTop(box.top - pageGap, bounded - 1);
  }
  /** Scrolls to a point of a page, given as fractions without rotation. */
  function goToPoint(
    number: number,
    point: { x: number; y: number },
    { align }: { align: "center" | "start" | "nearest" },
  ) {
    const element = viewport.current;
    const box = layout.boxes[number - 1];
    const size = shown?.sizes[number - 1];
    if (!element || !box || !size) return;
    const at = rotatePdfPoint(point.x, point.y, size.rotation + rotation);
    const y = box.top + at.y * box.height;
    const x = (element.scrollWidth - box.width) / 2 + at.x * box.width;
    const { scrollTop, scrollLeft, clientHeight, clientWidth } = element;
    const margin = Math.min(32, clientHeight / 4);
    const seen =
      y > scrollTop + margin &&
      y < scrollTop + clientHeight - margin &&
      x > scrollLeft &&
      x < scrollLeft + clientWidth - margin;
    if (align === "nearest" && seen) return;
    scrollToTop(
      align === "start" ? y - pageGap : y - clientHeight / 2,
      number - 1,
      Math.max(0, x - clientWidth / 2),
    );
  }
  const followLink = useStableCallback<
    NonNullable<DocumentProps["onItemClick"]>
  >(({ dest, pageNumber }) => {
    const top = destinationTop(dest);
    if (top === null || !shown) return goToPage(pageNumber);
    shown.pdf
      .getPage(pageNumber)
      .then((page) => {
        const place = page.getViewport({ scale: 1, rotation: 0 });
        const [, y] = place.convertToViewportPoint(0, top);
        goToPoint(
          pageNumber,
          { x: 0, y: Number(y) / place.height },
          { align: "start" },
        );
      })
      .catch(() => goToPage(pageNumber));
  });

  function zoomTo(next: Zoom, at?: { clientX: number; clientY: number }) {
    const element = viewport.current;
    if (element) {
      const bounds = element.getBoundingClientRect();
      keepPlace(
        at ? at.clientX - bounds.left : element.clientWidth / 2,
        at ? at.clientY - bounds.top : element.clientHeight / 2,
      );
    }
    setZoom(next);
  }
  useWheelZoom(viewport, (event) => {
    if (pages) zoomTo(wheelZoom(scale, event, zoomBounds), event);
  });

  return {
    pages,
    layout,
    scale,
    drawnScale: drawn.scale,
    rotation,
    rotate: () => setRotation((value) => (value + 90) % 360),
    scrolled,
    goToPage,
    goToPoint,
    followLink,
    zoom: {
      selected: zoom,
      canZoomIn: scale < zoomBounds.max,
      canZoomOut: scale > zoomBounds.min,
      to: zoomTo,
      step: (delta: number) => zoomTo(stepZoom(scale, delta, zoomBounds)),
    },
  };
}

export type PdfView = ReturnType<typeof usePdfView>;
