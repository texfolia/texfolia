import { Toolbar } from "@base-ui/react/toolbar";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconMaximize,
  IconPalette,
  IconRotateClockwise,
  IconZoomIn,
  IconZoomOut,
  IconDots,
} from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@texfolia/ui/dropdown-menu";
import { Input } from "@texfolia/ui/input";
import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";

import {
  PanelAction,
  PanelActions,
  PanelHeader,
} from "#/components/panel-header";
import { reportCompilePreview } from "#/lib/compile";
import {
  pdfToSource,
  rotatePdfPoint,
  type SyncTexIndex,
  type SyncTexLocation,
} from "#/lib/editor/latex/synctex";
import { downloadFile } from "#/lib/storage/browser";
import { useTheme } from "#/providers/theme-provider";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type PdfFile = string | File;
type PdfSync = {
  index: SyncTexIndex;
  reveal: (path: string, line: number) => void;
  target: SyncTexLocation | null;
};
type PdfViewerProps = { file: PdfFile; filename?: string; sync?: PdfSync };
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; pages: number }
  | { kind: "error"; message: string };
type Zoom = { kind: "fit" } | { kind: "scale"; value: number };

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
  const pageElement = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [zoom, setZoom] = useState<Zoom>({ kind: "fit" });
  const [rotation, setRotation] = useState(0);
  const [nativeSize, setNativeSize] = useState({
    width: 612,
    height: 792,
    rotation: 0,
  });
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const loadedFile = useRef<PdfFile | null>(null);
  const ready = file === loadedFile.current && load.kind === "ready";
  const pages = ready ? load.pages : 0;
  const rotated = (nativeSize.rotation + rotation) % 180 !== 0;
  const pageWidth = rotated ? nativeSize.height : nativeSize.width;
  const fitScale = Math.max(1, width - 32) / pageWidth;
  const scale = zoom.kind === "fit" ? fitScale : zoom.value;

  useEffect(() => {
    setPage(1);
    setPageInput("1");
    setZoom({ kind: "fit" });
    setRotation(0);
    setLoad({ kind: "loading" });
    setDownloadError("");
  }, [file]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function goToPage(next: number) {
    const bounded = Math.min(pages, Math.max(1, Math.trunc(next)));
    if (!Number.isFinite(bounded) || pages === 0) return;
    setPage(bounded);
    setPageInput(String(bounded));
    viewport.current?.scrollTo({ top: 0, left: 0 });
  }

  const target = sync?.target;
  useEffect(() => {
    if (ready && target) goToPage(target.page);
  }, [ready, target]);

  useEffect(() => {
    if (!target || target.page !== page) return;
    const frame = requestAnimationFrame(() =>
      marker.current?.scrollIntoView({ block: "center", inline: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [target, page, scale, rotation, nativeSize]);

  const totalRotation = (nativeSize.rotation + rotation) % 360;
  const corners =
    target && target.page === page
      ? [
          rotatePdfPoint(
            target.x / nativeSize.width,
            target.y / nativeSize.height,
            totalRotation,
          ),
          rotatePdfPoint(
            (target.x + target.width) / nativeSize.width,
            (target.y + target.height) / nativeSize.height,
            totalRotation,
          ),
        ]
      : null;

  function changeZoom(delta: number) {
    setZoom({
      kind: "scale",
      value: Math.min(
        3,
        Math.max(0.25, Math.round((scale + delta) * 100) / 100),
      ),
    });
  }

  async function download() {
    if (!file) return;
    setDownloading(true);
    setDownloadError("");
    try {
      if (file instanceof File) downloadFile(file, filename);
      else {
        const response = await fetch(file);
        if (!response.ok) throw new Error("Download failed");
        downloadFile(await response.blob(), filename);
      }
    } catch {
      setDownloadError("Could not download the PDF. Try again.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section
      aria-label="PDF preview"
      className="bg-background flex h-full min-h-0 min-w-0 flex-col"
    >
      <PanelHeader title={file ? filename : "PDF preview"}>
        <PanelActions label="PDF actions">
          <Toolbar.Group
            className="flex items-center gap-1"
            aria-label="Page navigation"
          >
            <PanelAction
              label="Previous page"
              disabled={!ready || page <= 1}
              onClick={() => goToPage(page - 1)}
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
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={() => {
                if (pageInput.trim() && Number.isFinite(Number(pageInput)))
                  goToPage(Number(pageInput));
                else setPageInput(String(page));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (pageInput.trim()) goToPage(Number(pageInput));
                }
                if (event.key === "Escape") setPageInput(String(page));
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
              disabled={!ready || page >= pages}
              onClick={() => goToPage(page + 1)}
            >
              <IconChevronRight />
            </PanelAction>
          </Toolbar.Group>
          <span className="text-muted-foreground text-xs tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <PanelAction
            label="Fit to width"
            disabled={!ready}
            aria-pressed={zoom.kind === "fit"}
            onClick={() => setZoom({ kind: "fit" })}
          >
            <IconMaximize />
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
                disabled={!ready || scale >= 3}
                onClick={() => changeZoom(0.25)}
              >
                <IconZoomIn />
                Zoom in
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!ready || scale <= 0.25}
                onClick={() => changeZoom(-0.25)}
              >
                <IconZoomOut />
                Zoom out
              </DropdownMenuItem>
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
      {downloadError && (
        <p role="alert" className="text-destructive px-3 py-2 text-xs">
          {downloadError}
        </p>
      )}
      {sync && (
        <p className="text-muted-foreground border-b px-3 py-1 text-xs">
          Cmd/Ctrl-click the PDF to reveal its source. Cmd/Ctrl-click source to
          reveal it here.
        </p>
      )}
      <div
        ref={viewport}
        data-pdf-mode={appearance.pdfMode}
        data-pdf-dark={matchTheme && theme.mode === "dark" ? "true" : undefined}
        className="min-h-0 flex-1 overflow-auto data-[pdf-mode=match]:bg-(--pdf-surround) data-[pdf-mode=original]:bg-(--pdf-original-surround) data-[pdf-mode=original]:text-(--pdf-original-foreground) data-[pdf-mode=original]:[--foreground:var(--pdf-original-foreground)] data-[pdf-mode=original]:[--muted-foreground:var(--pdf-original-foreground)] data-[pdf-dark=true]:[&_.react-pdf__Page]:[filter:invert(0.9)_hue-rotate(180deg)]"
      >
        <Document
          key={retry}
          file={file}
          suspense={false}
          className="flex min-h-full w-fit min-w-full flex-col items-center p-4"
          onLoadSuccess={({ numPages }) => {
            loadedFile.current = file;
            setLoad({ kind: "ready", pages: numPages });
          }}
          onLoadError={() => {
            reportCompilePreview(file, "preview_failed");
            setLoad({
              kind: "error",
              message:
                "Could not load this PDF. It may be damaged or unavailable.",
            });
          }}
          onSourceError={() => {
            reportCompilePreview(file, "preview_failed");
            setLoad({
              kind: "error",
              message: "Could not read this PDF. Try another file.",
            });
          }}
          onPassword={(respond, reason) => {
            const password = window.prompt(
              reason === 2
                ? "Incorrect password. Try again:"
                : "Enter the PDF password:",
            );
            if (password !== null) respond(password);
            else
              setLoad({
                kind: "error",
                message: "A password is required. Reopen the PDF to try again.",
              });
          }}
          onItemClick={({ pageNumber }) => {
            if (pageNumber) goToPage(pageNumber);
          }}
          loading={
            <p
              role={load.kind === "error" ? "alert" : "status"}
              className="text-muted-foreground p-8 text-sm"
            >
              {load.kind === "error" ? load.message : "Loading PDF…"}
            </p>
          }
          error={
            <div role="alert" className="space-y-3 p-8 text-center text-sm">
              <p>
                {load.kind === "error" ? load.message : "Could not load PDF."}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLoad({ kind: "loading" });
                  setRetry((value) => value + 1);
                }}
              >
                Try again
              </Button>
            </div>
          }
        >
          {ready && (
            <div
              ref={pageElement}
              className="relative w-fit"
              onClickCapture={(event) => {
                if (
                  !sync ||
                  event.button !== 0 ||
                  !(event.metaKey || event.ctrlKey)
                )
                  return;
                const bounds = pageElement.current?.getBoundingClientRect();
                if (!bounds?.width || !bounds.height) return;
                event.preventDefault();
                event.stopPropagation();
                const point = rotatePdfPoint(
                  (event.clientX - bounds.left) / bounds.width,
                  (event.clientY - bounds.top) / bounds.height,
                  -totalRotation,
                );
                const location = pdfToSource(
                  sync.index,
                  page,
                  point.x * nativeSize.width,
                  point.y * nativeSize.height,
                );
                if (location) sync.reveal(location.path, location.line);
              }}
            >
              <Page
                pageNumber={page}
                scale={scale}
                rotate={totalRotation}
                onRenderSuccess={() => reportCompilePreview(file, "rendered")}
                onRenderError={() =>
                  reportCompilePreview(file, "preview_failed")
                }
                onLoadSuccess={(pdfPage) => {
                  const box = pdfPage.getViewport({ scale: 1, rotation: 0 });
                  setNativeSize({
                    width: box.width,
                    height: box.height,
                    rotation: pdfPage.rotate,
                  });
                }}
                className="shadow-md"
                loading={
                  <p
                    role="status"
                    className="text-muted-foreground p-8 text-sm"
                  >
                    Loading page…
                  </p>
                }
                error={
                  <p role="alert" className="text-destructive p-8 text-sm">
                    Could not render this page. Try another page or reopen the
                    PDF.
                  </p>
                }
              />
              {corners && corners[0] && corners[1] && (
                <div
                  ref={marker}
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
          )}
        </Document>
      </div>
    </section>
  );
}
