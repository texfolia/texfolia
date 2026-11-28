import { cn } from "cn";
import { type PointerEvent, useRef } from "react";

type Bounds = { min: number; max: number };

const step = 16;

/** Which way the pointer moves to make the panel larger. */
const directions = {
  up: { axis: "y", sign: -1, grow: "ArrowUp", shrink: "ArrowDown" },
  left: { axis: "x", sign: -1, grow: "ArrowLeft", shrink: "ArrowRight" },
  right: { axis: "x", sign: 1, grow: "ArrowRight", shrink: "ArrowLeft" },
} as const;

const position = (event: PointerEvent, axis: "x" | "y") =>
  axis === "x" ? event.clientX : event.clientY;

/** The draggable border of a panel that grows in one direction. */
export function ResizeHandle({
  label,
  grows,
  size,
  bounds,
  controls,
  onResize,
  className,
}: {
  label: string;
  grows: keyof typeof directions;
  size: number;
  bounds: Bounds;
  /** The id of the panel. */
  controls?: string;
  onResize: (size: number) => void;
  className?: string;
}) {
  // One pointer drags at a time; others are ignored until it ends.
  const drag = useRef<{ pointerId: number; from: number; size: number }>(null);
  const { axis, sign, grow, shrink } = directions[grows];
  const resize = (next: number) =>
    onResize(Math.max(bounds.min, Math.min(bounds.max, next)));
  const isDragging = (event: PointerEvent) =>
    drag.current?.pointerId === event.pointerId;
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-controls={controls}
      tabIndex={0}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={size}
      className={cn(
        // Only a hairline shows. An invisible target around it is easier to hit,
        // and 25px for touch.
        "bg-border hover:bg-ring focus-visible:bg-ring relative shrink-0 touch-none outline-none select-none before:absolute",
        axis === "x"
          ? "w-px cursor-col-resize before:-inset-x-1 before:inset-y-0 pointer-coarse:before:-inset-x-3"
          : // Grows away from the panel's own controls.
            "h-px cursor-row-resize before:inset-x-0 before:-top-1.5 before:-bottom-0.5 pointer-coarse:before:-top-6 pointer-coarse:before:bottom-0",
        className,
      )}
      onKeyDown={(event) => {
        const next = {
          [grow]: size + step,
          [shrink]: size - step,
          Home: bounds.min,
          End: bounds.max,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        resize(next);
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          from: position(event, axis),
          size,
        };
      }}
      onPointerMove={(event) => {
        if (!drag.current || !isDragging(event)) return;
        resize(
          drag.current.size +
            (position(event, axis) - drag.current.from) * sign,
        );
      }}
      onPointerUp={(event) => {
        if (isDragging(event)) drag.current = null;
      }}
      // The browser took the gesture over, such as to scroll.
      onPointerCancel={(event) => {
        if (!drag.current || !isDragging(event)) return;
        resize(drag.current.size);
        drag.current = null;
      }}
      onLostPointerCapture={(event) => {
        if (isDragging(event)) drag.current = null;
      }}
    />
  );
}
