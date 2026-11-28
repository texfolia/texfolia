import { IconDownload, IconMaximize } from "@tabler/icons-react";
import { cn } from "cn";
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  PanelAction,
  PanelActions,
  PanelHeader,
} from "#/components/panel-header";
import { ZoomMenu } from "#/components/zoom-menu";
import { useWheelZoom } from "#/hooks/use-wheel-zoom";
import { downloadFile } from "#/lib/storage/browser";
import { stepZoom, wheelZoom } from "#/lib/zoom";

const bounds = { min: 0.05, max: 16 };
const padding = 16;
const fits = [{ value: "fit", label: "Fit to window" }] as const;

// Shows what is transparent. The colors are the theme's, so that it stays quiet.
const grid: CSSProperties = {
  backgroundImage:
    "conic-gradient(var(--muted) 25%, var(--background) 0 50%, var(--muted) 0 75%, var(--background) 0)",
  backgroundSize: "16px 16px",
};

type Size = { width: number; height: number };

/** An image with its dimensions, zoom, and a grid behind what is transparent. */
export function ImagePreview({ file }: { file: File }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState("");
  const [area, setArea] = useState<Size>({ width: 0, height: 0 });
  const [image, setImage] = useState<{ url: string; size: Size | null }>();
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  // The point of the image to keep in place through the next zoom.
  const focus = useRef<{ x: number; y: number; viewX: number; viewY: number }>(
    null,
  );
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () =>
      setArea((current) =>
        current.width === element.clientWidth &&
        current.height === element.clientHeight
          ? current
          : { width: element.clientWidth, height: element.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const failed = image?.url === url && image.size === null;
  // A replaced image keeps its predecessor's size until it has loaded.
  const size = image?.size;
  // Fitting shrinks a large image, and leaves a small one at its own size.
  const fitScale =
    size && area.width > 0 && area.height > 0
      ? Math.min(
          1,
          Math.max(1, area.width - padding * 2) / size.width,
          Math.max(1, area.height - padding * 2) / size.height,
        )
      : 1;
  const scale = zoom === "fit" ? fitScale : zoom;

  function zoomTo(next: number, at?: { clientX: number; clientY: number }) {
    const element = viewport.current;
    const shown = element?.querySelector("img")?.getBoundingClientRect();
    if (element && shown?.width && shown.height) {
      const frame = element.getBoundingClientRect();
      const viewX = at ? at.clientX - frame.left : frame.width / 2;
      const viewY = at ? at.clientY - frame.top : frame.height / 2;
      focus.current = {
        x: (frame.left + viewX - shown.left) / shown.width,
        y: (frame.top + viewY - shown.top) / shown.height,
        viewX,
        viewY,
      };
    }
    setZoom(next);
  }
  useLayoutEffect(() => {
    const element = viewport.current;
    const shown = element?.querySelector("img")?.getBoundingClientRect();
    const kept = focus.current;
    focus.current = null;
    if (!element || !shown || !kept) return;
    const frame = element.getBoundingClientRect();
    element.scrollBy(
      shown.left + kept.x * shown.width - frame.left - kept.viewX,
      shown.top + kept.y * shown.height - frame.top - kept.viewY,
    );
  }, [scale]);
  useWheelZoom(viewport, (event) => {
    if (size) zoomTo(wheelZoom(scale, event, bounds), event);
  });

  return (
    <section
      aria-label="Image preview"
      className="bg-background flex h-full min-h-0 min-w-0 flex-col"
    >
      <PanelHeader title={file.name}>
        {size && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {size.width} × {size.height}
          </span>
        )}
        <PanelActions label="Image actions">
          <ZoomMenu
            scale={scale}
            selected={zoom}
            fits={fits}
            disabled={!size}
            canZoomIn={scale < bounds.max}
            canZoomOut={scale > bounds.min}
            onStep={(delta) => zoomTo(stepZoom(scale, delta, bounds))}
            onFit={setZoom}
            onScale={zoomTo}
          />
          <PanelAction
            label="Fit to window"
            disabled={!size}
            aria-pressed={zoom === "fit"}
            onClick={() => setZoom("fit")}
          >
            <IconMaximize />
          </PanelAction>
          <PanelAction
            label="Download image"
            onClick={() => downloadFile(file, file.name)}
          >
            <IconDownload />
          </PanelAction>
        </PanelActions>
      </PanelHeader>
      <div
        ref={viewport}
        tabIndex={0}
        role="group"
        aria-label={`${file.name} image`}
        className="focus-visible:ring-ring/50 grid min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        {failed ? (
          <p role="alert" className="text-destructive p-4 text-sm">
            This image could not be shown. It may be damaged.
          </p>
        ) : (
          url && (
            <img
              src={url}
              alt={file.name}
              draggable={false}
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                // A vector image may have no size of its own.
                setImage({
                  url,
                  size: {
                    width: naturalWidth || 300,
                    height: naturalHeight || 150,
                  },
                });
              }}
              onError={() => setImage({ url, size: null })}
              className={cn(
                // Auto margins center it without cutting off what overflows.
                "m-auto max-w-none",
                !size && "invisible",
                scale >= 4 && "[image-rendering:pixelated]",
              )}
              style={
                size
                  ? {
                      ...grid,
                      width: size.width * scale,
                      height: size.height * scale,
                    }
                  : undefined
              }
            />
          )
        )}
      </div>
    </section>
  );
}
