import { expect, test } from "bun:test";

import {
  anchorAt,
  currentPage,
  layoutPages,
  pageAt,
  pageGap,
  scrollTo,
  visiblePages,
} from "./layout";

const portrait = { width: 100, height: 200, rotation: 0 };
const sizes = [portrait, { ...portrait, rotation: 90 }, portrait];

test("pages stack with gaps, and rotations swap their sides", () => {
  const layout = layoutPages(sizes, 2, 0);
  expect(layout.boxes).toEqual([
    { top: pageGap, width: 200, height: 400 },
    { top: pageGap * 2 + 400, width: 400, height: 200 },
    { top: pageGap * 3 + 600, width: 200, height: 400 },
  ]);
  expect(layout.width).toBe(400 + pageGap * 2);
  expect(layout.height).toBe(1000 + pageGap * 4);
  expect(layoutPages(sizes, 2, 90).boxes[1]).toMatchObject({
    width: 200,
    height: 400,
  });
});

test("the visible range leaves out pages above and below the viewport", () => {
  const layout = layoutPages([portrait, portrait, portrait], 1, 0);
  const second = layout.boxes[1]!.top;
  expect(pageAt(layout, 0)).toBe(0);
  expect(visiblePages(layout, 0, 100)).toEqual({ first: 0, last: 0 });
  expect(visiblePages(layout, 0, second + 1)).toEqual({ first: 0, last: 1 });
  // Only the gap above the second page shows.
  expect(visiblePages(layout, second - 4, 100)).toEqual({ first: 1, last: 1 });
  expect(visiblePages(layout, layout.height, 100).last).toBe(2);
  expect(currentPage(layout, second - 20, 300)).toBe(1);
  expect(visiblePages(layoutPages([], 1, 0), 0, 100)).toEqual({
    first: 0,
    last: 0,
  });
});

test("an anchor keeps its place through zoom, rotation, and a shorter document", () => {
  const before = layoutPages([portrait, portrait, portrait], 1, 0);
  const place = { viewX: 60, viewY: 80 };
  const at = { top: before.boxes[2]!.top + 20, left: 0 };
  const anchor = anchorAt(before, 200, at, place)!;
  expect(anchor).toMatchObject({ page: 2, x: 0.1, y: 0.5 });
  expect(scrollTo(before, 200, anchor)).toEqual(at);

  const zoomed = layoutPages([portrait, portrait, portrait], 3, 0);
  expect(scrollTo(zoomed, 400, anchor)).toEqual({
    top: zoomed.boxes[2]!.top + 300 - 80,
    left: 50 + 30 - 60,
  });
  const shorter = layoutPages([portrait], 1, 0);
  expect(scrollTo(shorter, 200, anchor)?.top).toBe(pageGap + 100 - 80);
  expect(scrollTo(layoutPages([], 1, 0), 200, anchor)).toBeNull();
});
