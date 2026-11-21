import { useRef } from "react";

export function SidebarResize({
  side,
  width,
  onResize,
  label,
}: {
  label?: string;
  side: "left" | "right";
  width: number;
  onResize: (width: number) => void;
}) {
  const start = useRef({ x: 0, width });
  const clamp = (value: number) => Math.max(240, Math.min(600, value));
  return (
    <div
      role="separator"
      aria-label={
        label ?? `Resize ${side === "left" ? "agents" : "right"} sidebar`
      }
      aria-orientation="vertical"
      tabIndex={0}
      aria-valuemin={240}
      aria-valuemax={600}
      aria-valuenow={width}
      className="bg-border hover:bg-ring focus-visible:bg-ring z-10 w-1 shrink-0 cursor-col-resize touch-none outline-none max-md:hidden"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onResize(
            clamp(
              width +
                (event.key === "ArrowRight" ? 16 : -16) *
                  (side === "left" ? 1 : -1),
            ),
          );
        }
      }}
      onPointerDown={(event) => {
        start.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          onResize(
            clamp(
              start.current.width +
                (event.clientX - start.current.x) * (side === "left" ? 1 : -1),
            ),
          );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}
