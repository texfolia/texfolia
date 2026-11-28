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
import { useState } from "react";

import {
  PanelAction,
  PanelActions,
  PanelHeader,
} from "#/components/panel-header";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { ZoomMenu } from "#/components/zoom-menu";
import { useTheme } from "#/providers/theme-provider";

import type { PdfActions } from "../-hooks/use-pdf-actions";
import { pdfFits, type PdfView } from "../-hooks/use-pdf-view";

export function PdfToolbar({
  title,
  ready,
  current,
  view,
  actions,
  searching,
  onSearch,
}: {
  title: string;
  /** A document shows. */
  ready: boolean;
  /** The index of the page the reader is on. */
  current: number;
  view: PdfView;
  actions: PdfActions;
  searching: boolean;
  onSearch: () => void;
}) {
  const { appearance, setPdfMode } = useTheme();
  const matchTheme = appearance.pdfMode === "match";
  return (
    <PanelHeader title={title}>
      <PanelActions label="PDF actions">
        <PageNavigation ready={ready} current={current} view={view} />
        <ZoomMenu
          scale={view.scale}
          selected={view.zoom.selected}
          fits={pdfFits}
          disabled={!ready}
          canZoomIn={view.zoom.canZoomIn}
          canZoomOut={view.zoom.canZoomOut}
          onStep={view.zoom.step}
          onFit={view.zoom.to}
          onScale={view.zoom.to}
        />
        <PanelAction
          label="Fit to width"
          disabled={!ready}
          aria-pressed={view.zoom.selected === "width"}
          onClick={() => view.zoom.to("width")}
        >
          <IconMaximize />
        </PanelAction>
        <PanelAction
          label="Find in PDF (⌘/Ctrl+F)"
          disabled={!ready}
          aria-pressed={searching}
          onClick={onSearch}
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
            <DropdownMenuItem disabled={!ready} onClick={view.rotate}>
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
              disabled={!ready || !!actions.printing}
              onClick={actions.print}
            >
              <IconPrinter />
              Print…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!ready || actions.downloading}
              onClick={actions.download}
            >
              <IconDownload />
              Download PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PanelActions>
    </PanelHeader>
  );
}

function PageNavigation({
  ready,
  current,
  view,
}: {
  ready: boolean;
  current: number;
  view: PdfView;
}) {
  const { pages } = view;
  // What is being typed, until it is entered.
  const [pageInput, setPageInput] = useState<string | null>(null);
  return (
    <Toolbar.Group
      className="flex items-center gap-1"
      aria-label="Page navigation"
    >
      <PanelAction
        label="Previous page"
        disabled={!ready || current <= 0}
        onClick={() => view.goToPage(current)}
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
        value={pageInput ?? String(current + 1)}
        onChange={(event) => setPageInput(event.target.value)}
        onBlur={() => {
          if (pageInput?.trim()) view.goToPage(Number(pageInput));
          setPageInput(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (pageInput?.trim()) view.goToPage(Number(pageInput));
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
        disabled={!ready || current >= pages - 1}
        onClick={() => view.goToPage(current + 2)}
      >
        <IconChevronRight />
      </PanelAction>
    </Toolbar.Group>
  );
}
