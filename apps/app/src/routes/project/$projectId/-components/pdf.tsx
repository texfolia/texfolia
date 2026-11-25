import { Toolbar } from "@base-ui/react/toolbar";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDots,
  IconDownload,
  IconMaximize,
  IconPalette,
  IconPrinter,
  IconRotateClockwise,
  IconSearch,
} from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@texfolia/ui/dropdown-menu";
import { Input } from "@texfolia/ui/input";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  type ComponentProps,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Document, pdfjs } from "react-pdf";

import {
  PanelAction,
  PanelActions,
  PanelHeader,
} from "#/components/panel-header";
import { ZoomMenu } from "#/components/zoom-menu";
import { useStableCallback } from "#/hooks/use-stable-callback";
import { useWheelZoom } from "#/hooks/use-wheel-zoom";
import { reportCompilePreview } from "#/lib/compile";
import { debounce } from "#/lib/debounce";
import {
  pdfToSource,
  rotatePdfPoint,
  type SyncTexIndex,
  type SyncTexLocation,
} from "#/lib/editor/latex/synctex";
import { mapLimit } from "#/lib/map-limit";
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
import { printPdf } from "#/lib/pdf/print";
import { downloadFile } from "#/lib/storage/browser";
import { stepZoom, wheelZoom } from "#/lib/zoom";
import { useTheme } from "#/providers/theme-provider";

import { usePdfSearch } from "../-hooks/use-pdf-search";
import { PdfPages } from "./pdf-pages";
import { PdfPassword } from "./pdf-password";
import { PdfSearch } from "./pdf-search";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

// Each scale draws the pages again, so a drag or zoom draws them once at the end.
const resizeDelayMs = 150;
const drawDelayMs = 150;
// How long a new version may take to draw before it shows anyway.
const replaceDelayMs = 2000;
const readConcurrency = 8;
const zoomBounds = { min: 0.25, max: 3 };
const fits = [
  { value: "width", label: "Fit to width" },
  { value: "page", label: "Fit to page" },
] as const;

type PdfFile = string | File;
type PdfSync = {
  index: SyncTexIndex;
  reveal: (path: string, line: number) => void;
  target: SyncTexLocation | null;
};
type PdfViewerProps = { file: PdfFile; filename?: string; sync?: PdfSync };
type Zoom = (typeof fits)[number]["value"] | number;
type DocumentProps = ComponentProps<typeof Document>;

/** One version of the document. The next one loads behind the one that shows. */
type Version = {
  id: number;
  file: PdfFile;
  ready?: { pdf: PDFDocumentProxy; sizes: PageSize[] };
  error?: string;
};

const unknownSize: PageSize = { width: 612, height: 792, rotation: 0 };

async function pageSize(
  pdf: PDFDocumentProxy,
  number: number,
): Promise<PageSize> {
  const page = await pdf.getPage(number);
  const { width, height } = page.getViewport({ scale: 1, rotation: 0 });
  return { width, height, rotation: page.rotate };
}

const sameSizes = (a: readonly PageSize[], b: readonly PageSize[]) =>
  a.length === b.length &&
  a.every(
    (size, index) =>
      size.width === b[index]?.width &&
      size.height === b[index].height &&
      size.rotation === b[index].rotation,
  );

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

export default function PdfViewer({ file, filename, sync }: PdfViewerProps) {
  return (
    <PdfPanel
      file={file}
      sync={sync}
      filename={filename ?? (file instanceof File ? file.name : "document.pdf")}
    />
  );
}

function PdfPanel({
  file,
  filename,
  sync,
}: PdfViewerProps & { filename: string }) {
  const { appearance, setPdfMode, theme } = useTheme();
  const matchTheme = appearance.pdfMode === "match";
  const viewport = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 600, height: 800 });
  const [zoom, setZoom] = useState<Zoom>("width");
  const [rotation, setRotation] = useState(0);
  const [visible, setVisible] = useState({ first: 0, last: 0, current: 0 });
  const [pageInput, setPageInput] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [printing, setPrinting] = useState<{ page: number; of: number }>();
  const printAbort = useRef<AbortController>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [password, setPassword] = useState<{
    version: number;
    incorrect: boolean;
    phase: "asking" | "checking" | "cancelled";
    respond: (password: string) => void;
  }>();
  // The next version of a protected document likely has the same password.
  const lastPassword = useRef<string>(null);

  const [versions, setVersions] = useState<Version[]>(() => [{ id: 0, file }]);
  const latest = versions.at(-1);
  if (latest?.file !== file) {
    const shown = versions.find((version) => version.ready);
    setVersions([
      ...(shown ? [shown] : []),
      { id: (latest?.id ?? 0) + 1, file },
    ]);
  }
  const front = versions[0]?.ready ? versions[0] : undefined;
  const shown = front?.ready;
  const pages = shown?.sizes.length ?? 0;
  // Until the latest version shows, SyncTeX describes other pages.
  const current = front?.file === file;

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
  }, [layoutChanged]);

  function update(id: number, patch: Partial<Version>) {
    setVersions((previous) =>
      previous.map((version) =>
        version.id === id ? { ...version, ...patch } : version,
      ),
    );
  }
  /** Shows a version that loaded behind another one. */
  function replace(id: number) {
    setVersions((previous) => {
      const next = previous.find((version) => version.id === id);
      return next?.ready && previous.length > 1 ? [next] : previous;
    });
  }
  function failed(id: number, message: string) {
    setVersions((previous) => {
      const version = previous.find((version) => version.id === id);
      return version ? [{ id, file: version.file, error: message }] : previous;
    });
  }
  const loaded = useStableCallback(
    async (id: number, pdf: PDFDocumentProxy) => {
      try {
        const first = await pageSize(pdf, 1);
        // Most pages keep their size in the next version.
        const guess = Array.from({ length: pdf.numPages }, (_, index) =>
          index ? (shown?.sizes[index] ?? first) : first,
        );
        update(id, { ready: { pdf, sizes: guess } });
        const rest = await mapLimit(
          Array.from({ length: pdf.numPages - 1 }, (_, index) => index + 2),
          readConcurrency,
          (number) => pageSize(pdf, number),
        );
        const sizes = [first, ...rest];
        if (!sameSizes(sizes, guess)) update(id, { ready: { pdf, sizes } });
      } catch (error) {
        // A version that was replaced meanwhile has nothing left to read.
        console.error("The PDF's pages could not be read", error);
      }
    },
  );
  const loadFailed = useStableCallback((id: number, message: string) => {
    reportCompilePreview(file, "preview_failed");
    failed(id, message);
  });
  const passwordNeeded = useStableCallback(
    (id: number, respond: (password: string) => void, reason: number) => {
      const incorrect =
        reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD &&
        // A remembered password is a guess, not the reader's mistake.
        password?.version === id;
      if (reason === pdfjs.PasswordResponses.NEED_PASSWORD) {
        if (lastPassword.current !== null) {
          respond(lastPassword.current);
          return;
        }
      } else lastPassword.current = null;
      setPassword({ version: id, incorrect, phase: "asking", respond });
    },
  );
  const drawnPages = useRef(new Map<number, Set<number>>());
  const rendered = useStableCallback((id: number, page: number) => {
    if (id === latest?.id) reportCompilePreview(file, "rendered");
    if (id === front?.id) return;
    const done = drawnPages.current.get(id) ?? new Set();
    done.add(page);
    drawnPages.current.set(id, done);
    const count =
      versions.find((version) => version.id === id)?.ready?.sizes.length ?? 0;
    for (
      let index = Math.min(visible.first, count - 1);
      index <= Math.min(visible.last, count - 1);
      index++
    )
      if (!done.has(index + 1)) return;
    drawnPages.current.clear();
    replace(id);
  });
  const renderFailed = useStableCallback(() =>
    reportCompilePreview(file, "preview_failed"),
  );
  const waiting = versions.length > 1 && latest?.ready ? latest.id : undefined;
  const replaceWaiting = useStableCallback(replace);
  useEffect(() => {
    if (waiting === undefined) return;
    const timer = setTimeout(() => replaceWaiting(waiting), replaceDelayMs);
    return () => clearTimeout(timer);
  }, [waiting, replaceWaiting]);

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

  const target = sync && current ? sync.target : null;
  const revealTarget = useStableCallback(() => {
    const size = target && shown?.sizes[target.page - 1];
    if (target && size)
      goToPoint(
        target.page,
        {
          x: (target.x + target.width / 2) / size.width,
          y: (target.y + target.height / 2) / size.height,
        },
        { align: "center" },
      );
  });
  useEffect(() => {
    if (target && pages) revealTarget();
  }, [target, pages, revealTarget]);
  const reveal = useStableCallback((page: number, x: number, y: number) => {
    const location = sync && pdfToSource(sync.index, page, x, y);
    if (location) sync.reveal(location.path, location.line);
  });

  const search = usePdfSearch({
    pdf: shown?.pdf,
    open: searchOpen,
    onShow: (match) => goToPoint(match.page, match, { align: "nearest" }),
  });
  function openSearch() {
    setSearchOpen(true);
    setSearchFocus((value) => value + 1);
  }

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

  async function download() {
    setDownloading(true);
    setActionError("");
    try {
      if (file instanceof File) downloadFile(file, filename);
      else {
        const response = await fetch(file);
        if (!response.ok) throw new Error("Download failed");
        downloadFile(await response.blob(), filename);
      }
    } catch {
      setActionError("Could not download the PDF. Try again.");
    } finally {
      setDownloading(false);
    }
  }
  async function print() {
    if (!shown) return;
    const abort = new AbortController();
    printAbort.current?.abort();
    printAbort.current = abort;
    setActionError("");
    try {
      await printPdf(shown.pdf, {
        signal: abort.signal,
        onProgress: (page) => setPrinting({ page, of: shown.pdf.numPages }),
      });
    } catch {
      if (!abort.signal.aborted)
        setActionError(
          "Could not print the PDF. Download it to print it from another app.",
        );
    } finally {
      if (printAbort.current === abort) {
        printAbort.current = null;
        setPrinting(undefined);
      }
    }
  }
  useEffect(() => () => printAbort.current?.abort(), []);

  const asking = versions.some(({ id }) => id === password?.version)
    ? password
    : undefined;
  const ready = !!front;
  return (
    <section
      aria-label="PDF preview"
      className="bg-background flex h-full min-h-0 min-w-0 flex-col"
      onKeyDown={(event) => {
        if (
          event.key.toLowerCase() !== "f" ||
          !(event.metaKey || event.ctrlKey) ||
          event.altKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        openSearch();
      }}
    >
      <PanelHeader title={filename}>
        <PanelActions label="PDF actions">
          <Toolbar.Group
            className="flex items-center gap-1"
            aria-label="Page navigation"
          >
            <PanelAction
              label="Previous page"
              disabled={!ready || visible.current <= 0}
              onClick={() => goToPage(visible.current)}
            >
              <IconChevronLeft />
            </PanelAction>
            <Toolbar.Input
              render={<Input />}
              aria-label="Page number"
              type="number"
              min={1}
              max={pages || 1}
              disabled={!ready}
              value={pageInput ?? String(visible.current + 1)}
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={() => {
                if (pageInput?.trim()) goToPage(Number(pageInput));
                setPageInput(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (pageInput?.trim()) goToPage(Number(pageInput));
                  setPageInput(null);
                }
                if (event.key === "Escape") setPageInput(null);
              }}
              className="h-6 w-10 bg-transparent px-1 text-center text-xs tabular-nums"
            />
            <span
              className="text-muted-foreground text-xs tabular-nums"
              aria-live="polite"
            >
              / {pages || "—"}
            </span>
            <PanelAction
              label="Next page"
              disabled={!ready || visible.current >= pages - 1}
              onClick={() => goToPage(visible.current + 2)}
            >
              <IconChevronRight />
            </PanelAction>
          </Toolbar.Group>
          <ZoomMenu
            scale={scale}
            selected={zoom}
            fits={fits}
            disabled={!ready}
            canZoomIn={scale < zoomBounds.max}
            canZoomOut={scale > zoomBounds.min}
            onStep={(delta) => zoomTo(stepZoom(scale, delta, zoomBounds))}
            onFit={zoomTo}
            onScale={zoomTo}
          />
          <PanelAction
            label="Fit to width"
            disabled={!ready}
            aria-pressed={zoom === "width"}
            onClick={() => zoomTo("width")}
          >
            <IconMaximize />
          </PanelAction>
          <PanelAction
            label="Find in PDF (⌘/Ctrl+F)"
            disabled={!ready}
            aria-pressed={searchOpen}
            onClick={openSearch}
          >
            <IconSearch />
          </PanelAction>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" />}
              aria-label="More PDF actions"
              title="More PDF actions"
            >
              <IconDots />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                disabled={!ready}
                onClick={() => setRotation((value) => (value + 90) % 360)}
              >
                <IconRotateClockwise />
                Rotate clockwise
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={matchTheme}
                onCheckedChange={() =>
                  setPdfMode(matchTheme ? "original" : "match")
                }
              >
                <IconPalette />
                Match PDF to theme
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!ready || !!printing}
                onClick={() => void print()}
              >
                <IconPrinter />
                Print…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!ready || downloading}
                onClick={() => void download()}
              >
                <IconDownload />
                Download PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </PanelActions>
      </PanelHeader>
      {searchOpen && (
        <PdfSearch
          search={search}
          focusRequest={searchFocus}
          onClose={() => {
            setSearchOpen(false);
            viewport.current?.focus();
          }}
        />
      )}
      {actionError && (
        <p role="alert" className="text-destructive px-3 py-2 text-xs">
          {actionError}
        </p>
      )}
      {printing && (
        <div className="text-muted-foreground flex items-center gap-2 border-b px-3 py-1 text-xs">
          <p role="status" className="min-w-0 flex-1 tabular-nums">
            Preparing page {printing.page} of {printing.of} to print…
          </p>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => printAbort.current?.abort()}
          >
            Cancel
          </Button>
        </div>
      )}
      {sync && current && (
        <p className="text-muted-foreground border-b px-3 py-1 text-xs">
          Cmd/Ctrl-click the PDF to reveal its source. Cmd/Ctrl-click source to
          reveal it here.
        </p>
      )}
      <div
        ref={viewport}
        tabIndex={0}
        role="group"
        aria-label="PDF pages"
        data-pdf-mode={appearance.pdfMode}
        data-pdf-dark={matchTheme && theme.mode === "dark" ? "true" : undefined}
        onScroll={scrolled}
        className="focus-visible:ring-ring/50 grid min-h-0 flex-1 overflow-auto outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset data-[pdf-mode=match]:bg-(--pdf-surround) data-[pdf-mode=original]:bg-(--pdf-original-surround) data-[pdf-mode=original]:text-(--pdf-original-foreground) data-[pdf-mode=original]:[--foreground:var(--pdf-original-foreground)] data-[pdf-mode=original]:[--muted-foreground:var(--pdf-original-foreground)] data-[pdf-dark=true]:[&_.react-pdf__Page]:[filter:invert(0.9)_hue-rotate(180deg)] [&_mark]:bg-yellow-300/50 [&_mark]:text-transparent [&_mark[data-current]]:bg-orange-500/60"
      >
        {versions.map((version) => {
          const isFront = version.id === front?.id;
          const waitingForPassword =
            asking?.phase === "cancelled" && asking.version === version.id;
          return (
            <PdfVersion
              key={version.id}
              version={version}
              behind={!!front && !isFront}
              onLoad={loaded}
              onFail={loadFailed}
              onPassword={passwordNeeded}
              onLink={followLink}
              onRetry={() =>
                setVersions([{ id: version.id + 1, file: version.file }])
              }
              onEnterPassword={
                waitingForPassword
                  ? () => setPassword({ ...asking, phase: "asking" })
                  : undefined
              }
              layout={isFront ? layout : undefined}
              first={Math.max(0, visible.first - 1)}
              last={visible.last + 1}
              scale={scale}
              drawnScale={drawn.scale}
              rotation={rotation}
              target={isFront ? target : null}
              marks={isFront ? search.byPage : undefined}
              currentMatch={search.current}
              onReveal={sync && current && isFront ? reveal : undefined}
              onRendered={rendered}
              onRenderFailed={renderFailed}
            />
          );
        })}
      </div>
      {asking?.phase === "asking" && (
        <PdfPassword
          key={asking.version}
          filename={filename}
          incorrect={asking.incorrect}
          onSubmit={(value) => {
            lastPassword.current = value;
            setPassword({ ...asking, phase: "checking" });
            asking.respond(value);
          }}
          onCancel={() => setPassword({ ...asking, phase: "cancelled" })}
        />
      )}
    </section>
  );
}

function PdfVersion({
  version,
  behind,
  layout: frontLayout,
  first,
  last,
  onLoad,
  onFail,
  onPassword,
  onLink,
  onRetry,
  onEnterPassword,
  onRendered,
  onRenderFailed,
  ...pages
}: {
  version: Version;
  /** Another version still shows in front of this one. */
  behind: boolean;
  layout: ReturnType<typeof layoutPages> | undefined;
  onLoad: (id: number, pdf: PDFDocumentProxy) => void;
  onFail: (id: number, message: string) => void;
  onPassword: (
    id: number,
    respond: (password: string) => void,
    reason: number,
  ) => void;
  onLink: NonNullable<DocumentProps["onItemClick"]>;
  onRetry: () => void;
  /** Set while the document waits for a password that was not entered. */
  onEnterPassword?: () => void;
  onRendered: (id: number, page: number) => void;
  onRenderFailed: () => void;
} & Omit<
  ComponentProps<typeof PdfPages>,
  "sizes" | "layout" | "onRendered" | "onFailed"
>) {
  const { id, ready } = version;
  const { scale, rotation } = pages;
  const layout = useMemo(
    () => frontLayout ?? layoutPages(ready?.sizes ?? [], scale, rotation),
    [frontLayout, ready?.sizes, scale, rotation],
  );
  const rendered = useStableCallback((page: number) => onRendered(id, page));
  // A shorter version shows its last pages instead.
  const end = Math.max(0, (ready?.sizes.length ?? 1) - 1);
  return (
    <div
      inert={behind}
      className="[grid-area:1/1] data-behind:invisible"
      data-behind={behind ? "" : undefined}
    >
      <Document
        file={version.file}
        suspense={false}
        className="min-h-full min-w-full"
        onLoadSuccess={(pdf) => onLoad(id, pdf)}
        onLoadError={() =>
          onFail(
            id,
            "Could not load this PDF. It may be damaged or unavailable.",
          )
        }
        onSourceError={() =>
          onFail(id, "Could not read this PDF. Try another file.")
        }
        onPassword={(respond, reason) =>
          onPassword(id, respond as (password: string) => void, reason)
        }
        onItemClick={onLink}
        loading={
          onEnterPassword ? (
            <div role="alert" className="space-y-3 p-8 text-center text-sm">
              <p>A password is required to show this PDF.</p>
              <Button variant="ghost" size="sm" onClick={onEnterPassword}>
                Enter password
              </Button>
            </div>
          ) : (
            <p role="status" className="text-muted-foreground p-8 text-sm">
              Loading PDF…
            </p>
          )
        }
        error={
          <div role="alert" className="space-y-3 p-8 text-center text-sm">
            <p>{version.error ?? "Could not load PDF."}</p>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        }
      >
        {ready && (
          <PdfPages
            {...pages}
            sizes={ready.sizes}
            layout={layout}
            first={Math.min(first, end)}
            last={Math.min(last, end)}
            onRendered={rendered}
            onFailed={onRenderFailed}
          />
        )}
      </Document>
    </div>
  );
}
