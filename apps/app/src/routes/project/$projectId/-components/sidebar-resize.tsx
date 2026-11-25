import { ResizeHandle } from "#/components/resize-handle";
import { sidebarWidthBounds } from "#/lib/workspace/workspace-layout";

export function SidebarResize({
  side,
  width,
  onResize,
  label = `Resize ${side === "left" ? "agents" : "right"} sidebar`,
}: {
  label?: string;
  side: "left" | "right";
  width: number;
  onResize: (width: number) => void;
}) {
  return (
    <ResizeHandle
      label={label}
      grows={side === "left" ? "right" : "left"}
      size={width}
      bounds={sidebarWidthBounds}
      onResize={onResize}
      // Above the sidebars, which would cover half of its target.
      className="z-40 max-md:hidden"
    />
  );
}
