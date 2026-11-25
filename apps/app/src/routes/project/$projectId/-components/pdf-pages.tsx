import { memo, useMemo, useRef } from "react";
import { Page } from "react-pdf";

import {
  rotatePdfPoint,
  type SyncTexLocation,
} from "#/lib/editor/latex/synctex";
import type { PagesLayout, PageBox, PageSize } from "#/lib/pdf/layout";
import { markItem } from "#/lib/pdf/search";

type ItemMarks = ReadonlyMap<
  number,
  readonly { from: number; to: number; match: number }[]
>;

type PageActions = {
  /** Ctrl/Cmd-click on a point of a page, in points from its top left. */
  onReveal?: (page: number, x: number, y: number) => void;
  onRendered: (page: number) => void;
  onFailed: () => void;
};

/** One page, in its place among the others. */
const PdfPage = memo(function PdfPage({
  number,
  size,
  box,
  scale,
  drawnScale,
  rotation,
  target,
  marks,
  currentMatch,
  onReveal,
  onRendered,
  onFailed,
}: {
  number: number;
  size: PageSize;
  box: PageBox;
  scale: number;
  /** The scale to draw at, which follows `scale` once it settles. */
  drawnScale: number;
  rotation: number;
  target: SyncTexLocation | undefined;
  marks: ItemMarks | undefined;
  currentMatch: number;
} & PageActions) {
  const element = useRef<HTMLDivElement>(null);
  const totalRotation = (size.rotation + rotation) % 360;
  // The renderer's identity redraws the text, so pages without matches have none.
  const textRenderer = useMemo(
    () =>
      marks &&
      (({ str, itemIndex }: { str: string; itemIndex: number }) =>
        markItem(
          str,
          (marks.get(itemIndex) ?? []).map(({ from, to, match }) => ({
            from,
            to,
            current: match === currentMatch,
          })),
        )),
    [marks, currentMatch],
  );
  const corners = target && [
    rotatePdfPoint(
      target.x / size.width,
      target.y / size.height,
      totalRotation,
    ),
    rotatePdfPoint(
      (target.x + target.width) / size.width,
      (target.y + target.height) / size.height,
      totalRotation,
    ),
  ];
  return (
    <div
      ref={element}
      data-page={number}
      className="absolute left-1/2 -translate-x-1/2 overflow-hidden shadow-md"
      style={{ top: box.top, width: box.width, height: box.height }}
      onClickCapture={(event) => {
        if (
          !onReveal ||
          event.button !== 0 ||
          !(event.metaKey || event.ctrlKey)
        )
          return;
        const bounds = element.current?.getBoundingClientRect();
        if (!bounds?.width || !bounds.height) return;
        event.preventDefault();
        event.stopPropagation();
        const point = rotatePdfPoint(
          (event.clientX - bounds.left) / bounds.width,
          (event.clientY - bounds.top) / bounds.height,
          -totalRotation,
        );
        onReveal(number, point.x * size.width, point.y * size.height);
      }}
    >
      <div
        className="w-fit origin-top-left"
        style={
          scale === drawnScale
            ? undefined
            : { transform: `scale(${scale / drawnScale})` }
        }
      >
        <Page
          pageNumber={number}
          scale={drawnScale}
          rotate={totalRotation}
          suspense={false}
          customTextRenderer={textRenderer}
          onRenderSuccess={() => onRendered(number)}
          onRenderError={onFailed}
          loading={
            <p role="status" className="p-8 text-sm text-neutral-500">
              Loading page…
            </p>
          }
          error={
            <p role="alert" className="text-destructive p-8 text-sm">
              Could not render this page. Try another page or reopen the PDF.
            </p>
          }
        />
      </div>
      {corners?.[0] && corners[1] && (
        <div
          aria-label="Source location in PDF"
          className="border-primary bg-primary/20 pointer-events-none absolute min-h-1 min-w-1 border"
          style={{
            left: `${Math.min(corners[0].x, corners[1].x) * 100}%`,
            top: `${Math.min(corners[0].y, corners[1].y) * 100}%`,
            width: `${Math.abs(corners[1].x - corners[0].x) * 100}%`,
            height: `${Math.abs(corners[1].y - corners[0].y) * 100}%`,
          }}
        />
      )}
    </div>
  );
});

/** A column of pages. Only those from `first` to `last` are drawn. */
export function PdfPages({
  sizes,
  layout,
  first,
  last,
  target,
  marks,
  currentMatch,
  ...page
}: {
  sizes: readonly PageSize[];
  layout: PagesLayout;
  /** Page indexes, inclusive. */
  first: number;
  last: number;
  scale: number;
  drawnScale: number;
  rotation: number;
  target: SyncTexLocation | null;
  marks: ReadonlyMap<number, ItemMarks> | undefined;
  currentMatch: number;
} & PageActions) {
  return (
    <div
      className="relative min-w-full"
      style={{ width: layout.width, height: layout.height }}
    >
      {sizes.map((size, index) => {
        const box = layout.boxes[index];
        if (!box || index < first || index > last) return null;
        const number = index + 1;
        const pageMarks = marks?.get(number);
        return (
          <PdfPage
            key={number}
            number={number}
            size={size}
            box={box}
            target={target?.page === number ? target : undefined}
            marks={pageMarks}
            currentMatch={pageMarks ? currentMatch : -1}
            {...page}
          />
        );
      })}
    </div>
  );
}
