/** A page's size without any rotation, and its own rotation. */
export type PageSize = { width: number; height: number; rotation: number };

/** The space around and between pages, in pixels at any zoom. */
export const pageGap = 16;

export type PageBox = {
  top: number;
  width: number;
  height: number;
};
export type PagesLayout = {
  boxes: PageBox[];
  width: number;
  height: number;
};

export function rotatedSize(size: PageSize, rotation: number) {
  return (size.rotation + rotation) % 180 === 0
    ? { width: size.width, height: size.height }
    : { width: size.height, height: size.width };
}

/** Stacks pages in one column. */
export function layoutPages(
  sizes: readonly PageSize[],
  scale: number,
  rotation: number,
): PagesLayout {
  let top = pageGap;
  let width = 0;
  const boxes = sizes.map((size) => {
    const rotated = rotatedSize(size, rotation);
    const box = {
      top,
      width: rotated.width * scale,
      height: rotated.height * scale,
    };
    top += box.height + pageGap;
    width = Math.max(width, box.width);
    return box;
  });
  return { boxes, width: width + pageGap * 2, height: top };
}

/** The index of the page at a height, counting the gap below it as its own. */
export function pageAt({ boxes }: PagesLayout, y: number) {
  let low = 0;
  let high = boxes.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((boxes[middle]?.top ?? 0) <= y) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The pages a viewport shows. Indexes are inclusive. */
export function visiblePages(
  layout: PagesLayout,
  top: number,
  height: number,
): { first: number; last: number } {
  const at = pageAt(layout, top);
  const box = layout.boxes[at];
  // Only the gap below the page is inside the viewport.
  const past = box && box.top + box.height <= top;
  const last = pageAt(layout, top + Math.max(0, height - 1));
  return { first: Math.min(past ? at + 1 : at, last), last };
}

/** The page being read: the one a third of the way down the viewport. */
export function currentPage(layout: PagesLayout, top: number, height: number) {
  return pageAt(layout, top + height / 3);
}

/**
 * A point of a page that stays at a point of the viewport while the zoom, the
 * rotation, or the document changes. Page fractions can lie outside of it.
 */
export type ScrollAnchor = {
  page: number;
  x: number;
  y: number;
  viewX: number;
  viewY: number;
};
type Scroll = { top: number; left: number };

const pageLeft = (box: PageBox, contentWidth: number) =>
  (contentWidth - box.width) / 2;

export function anchorAt(
  layout: PagesLayout,
  contentWidth: number,
  { top, left }: Scroll,
  { viewX, viewY }: { viewX: number; viewY: number },
): ScrollAnchor | null {
  const page = pageAt(layout, top + viewY);
  const box = layout.boxes[page];
  if (!box) return null;
  return {
    page,
    x: (left + viewX - pageLeft(box, contentWidth)) / box.width,
    y: (top + viewY - box.top) / box.height,
    viewX,
    viewY,
  };
}

export function scrollTo(
  layout: PagesLayout,
  contentWidth: number,
  anchor: ScrollAnchor,
): Scroll | null {
  // A shorter document shows its last page.
  const box = layout.boxes[Math.min(anchor.page, layout.boxes.length - 1)];
  if (!box) return null;
  return {
    top: box.top + anchor.y * box.height - anchor.viewY,
    left: pageLeft(box, contentWidth) + anchor.x * box.width - anchor.viewX,
  };
}
