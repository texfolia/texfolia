import { Button } from "@texfolia/ui/button";
import { useEffect, useRef, useState } from "react";
import { pdfjs } from "react-pdf";

import { useStableCallback } from "#/hooks/use-stable-callback";
import {
  pdfToSource,
  type SyncTexIndex,
  type SyncTexLocation,
} from "#/lib/editor/latex/synctex";
import { useTheme } from "#/providers/theme-provider";

import { usePdfActions } from "../-hooks/use-pdf-actions";
import { usePdfSearch } from "../-hooks/use-pdf-search";
import { type PdfFile, usePdfVersions } from "../-hooks/use-pdf-versions";
import { usePdfView, type VisiblePages } from "../-hooks/use-pdf-view";
import { PdfPassword } from "./pdf-password";
import { PdfSearch } from "./pdf-search";
import { PdfToolbar } from "./pdf-toolbar";
import { PdfVersion } from "./pdf-version";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type PdfSync = {
  index: SyncTexIndex;
  reveal: (path: string, line: number) => void;
  target: SyncTexLocation | null;
};
type PdfViewerProps = { file: PdfFile; filename?: string; sync?: PdfSync };

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
  const { appearance, theme } = useTheme();
  const viewport = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<VisiblePages>({
    first: 0,
    last: 0,
    current: 0,
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const documents = usePdfVersions(file, visible);
  const { versions, front, shown, current, password } = documents;
  const view = usePdfView({ viewport, front, setVisible });
  const { pages, goToPoint } = view;
  const actions = usePdfActions({ file, filename, pdf: shown?.pdf });
  const { printing } = actions;

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
      <PdfToolbar
        title={filename}
        ready={!!front}
        current={visible.current}
        view={view}
        actions={actions}
        searching={searchOpen}
        onSearch={openSearch}
      />
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
      {actions.error && (
        <p role="alert" className="text-destructive px-3 py-2 text-xs">
          {actions.error}
        </p>
      )}
      {printing && (
        <div className="text-muted-foreground flex items-center gap-2 border-b px-3 py-1 text-xs">
          <p role="status" className="min-w-0 flex-1 tabular-nums">
            Preparing page {printing.page} of {printing.of} to print…
          </p>
          <Button variant="ghost" size="xs" onClick={actions.cancelPrint}>
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
        data-pdf-dark={
          appearance.pdfMode === "match" && theme.mode === "dark"
            ? "true"
            : undefined
        }
        onScroll={view.scrolled}
        className="focus-visible:ring-ring/50 grid min-h-0 flex-1 overflow-auto outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset data-[pdf-mode=match]:bg-(--pdf-surround) data-[pdf-mode=original]:bg-(--pdf-original-surround) data-[pdf-mode=original]:text-(--pdf-original-foreground) data-[pdf-mode=original]:[--foreground:var(--pdf-original-foreground)] data-[pdf-mode=original]:[--muted-foreground:var(--pdf-original-foreground)] data-[pdf-dark=true]:[&_.react-pdf__Page]:[filter:invert(0.9)_hue-rotate(180deg)] [&_mark]:bg-(--pdf-mark) [&_mark]:text-transparent [&_mark[data-current]]:bg-(--pdf-mark-current)"
      >
        {versions.map((version) => {
          const isFront = version.id === front?.id;
          const cancelled =
            password?.phase === "cancelled" && password.version === version.id;
          return (
            <PdfVersion
              key={version.id}
              version={version}
              behind={!!front && !isFront}
              onLoad={documents.load}
              onFail={documents.fail}
              onPassword={documents.askPassword}
              onLink={view.followLink}
              onRetry={() => documents.retry(version)}
              onEnterPassword={cancelled ? password.ask : undefined}
              layout={isFront ? view.layout : undefined}
              first={Math.max(0, visible.first - 1)}
              last={visible.last + 1}
              scale={view.scale}
              drawnScale={view.drawnScale}
              rotation={view.rotation}
              target={isFront ? target : null}
              marks={isFront ? search.byPage : undefined}
              currentMatch={search.current}
              onReveal={sync && current && isFront ? reveal : undefined}
              onRendered={documents.drawn}
              onRenderFailed={documents.drawFailed}
            />
          );
        })}
      </div>
      {password?.phase === "asking" && (
        <PdfPassword
          key={password.version}
          filename={filename}
          incorrect={password.incorrect}
          onSubmit={password.submit}
          onCancel={password.cancel}
        />
      )}
    </section>
  );
}
