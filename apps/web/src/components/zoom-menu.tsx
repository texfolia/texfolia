import { IconZoomIn, IconZoomOut } from "@tabler/icons-react";

import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { zoomPercent, zoomPresets } from "#/lib/zoom";

/** The current zoom, with a menu of steps, fits, and fixed scales. */
export function ZoomMenu<Fit extends string>({
  scale,
  selected,
  fits,
  disabled,
  canZoomIn,
  canZoomOut,
  onStep,
  onFit,
  onScale,
}: {
  scale: number;
  /** The chosen fit, or the chosen scale. */
  selected: Fit | number;
  fits: readonly { value: Fit; label: string }[];
  disabled?: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onStep: (delta: number) => void;
  onFit: (fit: Fit) => void;
  onScale: (scale: number) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground w-12 px-0 text-xs tabular-nums"
          />
        }
        aria-label={`Zoom, ${zoomPercent(scale)}`}
        title="Zoom (Ctrl/⌘ + scroll)"
        disabled={disabled}
      >
        {zoomPercent(scale)}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          disabled={!canZoomIn}
          closeOnClick={false}
          onClick={() => onStep(0.25)}
        >
          <IconZoomIn />
          Zoom in
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canZoomOut}
          closeOnClick={false}
          onClick={() => onStep(-0.25)}
        >
          <IconZoomOut />
          Zoom out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={String(selected)}
          onValueChange={(value: string) => {
            const fit = fits.find((fit) => fit.value === value);
            if (fit) onFit(fit.value);
            else onScale(Number(value));
          }}
        >
          {fits.map(({ value, label }) => (
            <DropdownMenuRadioItem key={value} value={value} closeOnClick>
              {label}
            </DropdownMenuRadioItem>
          ))}
          {zoomPresets.map((preset) => (
            <DropdownMenuRadioItem
              key={preset}
              value={String(preset)}
              closeOnClick
            >
              {zoomPercent(preset)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
