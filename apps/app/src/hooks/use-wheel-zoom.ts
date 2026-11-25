import { type RefObject, useEffect, useEffectEvent } from "react";

/**
 * Zooms on Ctrl/Cmd + wheel, which is also how browsers report a trackpad
 * pinch. Other scrolling is left alone.
 */
export function useWheelZoom(
  target: RefObject<HTMLElement | null>,
  onZoom: (event: WheelEvent) => void,
) {
  const zoom = useEffectEvent(onZoom);
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoom(event);
    };
    // React's wheel listeners are passive, so they cannot stop page zoom.
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [target]);
}
