/** The fixed scales offered by the zoom menus of previews. */
export const zoomPresets = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export function clampZoom(scale: number, min: number, max: number) {
  return Math.min(max, Math.max(min, scale));
}

/** The next scale for a step of the zoom buttons, in hundredths. */
export function stepZoom(
  scale: number,
  delta: number,
  bounds: { min: number; max: number },
) {
  return clampZoom(
    Math.round((scale + delta) * 100) / 100,
    bounds.min,
    bounds.max,
  );
}

/**
 * The next scale for a wheel or trackpad pinch. Wheels report lines or pages
 * where trackpads report pixels; either way one event zooms a limited amount.
 */
export function wheelZoom(
  scale: number,
  { deltaY, deltaMode }: Pick<WheelEvent, "deltaY" | "deltaMode">,
  bounds: { min: number; max: number },
) {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  const factor = Math.exp(-Math.min(100, Math.max(-100, pixels)) / 300);
  return clampZoom(scale * factor, bounds.min, bounds.max);
}

export const zoomPercent = (scale: number) => `${Math.round(scale * 100)}%`;
