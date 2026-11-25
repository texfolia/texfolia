import { extensionOf } from "./extension";

/** The image formats that browsers show. */
const imageTypes = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["svg", "image/svg+xml"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
]);

export function imageType(name: string): string | undefined {
  return imageTypes.get(extensionOf(name));
}

/** The type of a binary file that can be previewed. */
export function previewType(name: string) {
  return (
    imageType(name) ??
    (extensionOf(name) === "pdf" ? "application/pdf" : undefined)
  );
}

/** Whether a text file's source has a rendered preview. */
export function hasSourcePreview(name: string) {
  return /\.(?:md|markdown|svg)$/i.test(name);
}
