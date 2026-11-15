import { Toolbar } from "@base-ui/react/toolbar";
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFileText,
  IconFolderOpen,
  IconMaximize,
  IconPalette,
  IconRotateClockwise,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";

import {
  PanelAction,
  PanelActions,
  PanelHeader,
} from "#/components/panel-header";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { downloadFile } from "#/lib/download-file";
import { reportCompilePreview } from "#/lib/latex/compile-telemetry";
import { useTheme } from "#/providers/theme-provider";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type PdfFile = string | File | null;
type PdfViewerProps = { file?: PdfFile; filename?: string };
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; pages: number }
  | { kind: "error"; message: string };
type Zoom = { kind: "fit" } | { kind: "scale"; value: number };

export default function PdfViewer({
  file = null,
  filename = "document.pdf",
}: PdfViewerProps) {
  const [openedFile, setOpenedFile] = useState<File | null>(null);
  const source = openedFile ?? file;
  const name = source instanceof File ? source.name : filename;
  // A newly supplied compilation takes precedence over a manually opened PDF.
  const [previousFile, setPreviousFile] = useState(file);
  if (file !== previousFile) {
    setPreviousFile(file);
    setOpenedFile(null);
  }

  return <PdfPanel file={source} filename={name} onOpen={setOpenedFile} />;
}

function PdfPanel({
  file,
  filename,
  onOpen,
}: {
  file: PdfFile;
  filename: string;
  onOpen: (file: File) => void;
}) {
  const { appearance, setPdfMode, theme } = useTheme();
  const matchTheme = appearance.pdfMode === "match";
  const fileInput = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
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
  const loadedFile = useRef<PdfFile>(null);
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
          <PanelAction
            label={
              matchTheme ? "Show PDF in true colors" : "Match PDF to theme"
            }
            aria-pressed={matchTheme}
            onClick={() => setPdfMode(matchTheme ? "original" : "match")}
          >
            <IconPalette />
          </PanelAction>
          <PanelAction
            label="Open PDF"
            onClick={() => fileInput.current?.click()}
          >
            <IconFolderOpen />
          </PanelAction>
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
              className="h-7 w-12 px-1 text-center tabular-nums"
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
          <Toolbar.Group
            className="flex items-center gap-1"
            aria-label="Zoom controls"
          >
            <PanelAction
              label="Zoom out"
              disabled={!ready || scale <= 0.25}
              onClick={() => changeZoom(-0.25)}
            >
              <IconZoomOut />
            </PanelAction>
            <span
              className="min-w-10 text-center text-xs tabular-nums"
              aria-live="polite"
            >
              {Math.round(scale * 100)}%
            </span>
            <PanelAction
              label="Zoom in"
              disabled={!ready || scale >= 3}
              onClick={() => changeZoom(0.25)}
            >
              <IconZoomIn />
            </PanelAction>
            <PanelAction
              label="Fit to width"
              disabled={!ready}
              aria-pressed={zoom.kind === "fit"}
              onClick={() => setZoom({ kind: "fit" })}
            >
              <IconMaximize />
            </PanelAction>
          </Toolbar.Group>
          <PanelAction
            label="Rotate clockwise"
            disabled={!ready}
            onClick={() => setRotation((value) => (value + 90) % 360)}
          >
            <IconRotateClockwise />
          </PanelAction>
          <PanelAction
            label="Download PDF"
            disabled={!ready || downloading}
            onClick={() => void download()}
          >
            <IconDownload />
          </PanelAction>
        </PanelActions>
      </PanelHeader>
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        aria-label="Choose PDF file"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          if (selected) onOpen(selected);
        }}
      />
      {downloadError && (
        <p role="alert" className="text-destructive px-3 py-2 text-xs">
          {downloadError}
        </p>
      )}
      <div
        ref={viewport}
        data-pdf-mode={appearance.pdfMode}
        data-pdf-dark={matchTheme && theme.mode === "dark" ? "true" : undefined}
        className="min-h-0 flex-1 overflow-auto data-[pdf-mode=match]:bg-(--pdf-surround) data-[pdf-mode=original]:bg-(--pdf-original-surround) data-[pdf-mode=original]:text-(--pdf-original-foreground) data-[pdf-mode=original]:[--foreground:var(--pdf-original-foreground)] data-[pdf-mode=original]:[--muted-foreground:var(--pdf-original-foreground)] data-[pdf-dark=true]:[&_.react-pdf__Page]:[filter:invert(0.9)_hue-rotate(180deg)]"
      >
        {file ? (
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
                  message:
                    "A password is required. Reopen the PDF to try again.",
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
                  variant="outline"
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
              <Page
                pageNumber={page}
                scale={scale}
                rotate={(nativeSize.rotation + rotation) % 360}
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
            )}
          </Document>
        ) : (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-6 text-center">
            <IconFileText className="text-muted-foreground size-8" />
            <div>
              <p className="text-sm font-medium">No PDF open</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Open a PDF to preview it here.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInput.current?.click()}
            >
              <IconFolderOpen />
              Open PDF
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
