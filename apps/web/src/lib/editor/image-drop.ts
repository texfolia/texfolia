import { isImageFile } from "#/lib/projects/upload";

/** Extracts pasted image files from a clipboard `DataTransfer`, if any. */
export function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  if (data.items) {
    for (const item of data.items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file && isImageFile(file)) fromItems.push(file);
    }
  }
  if (fromItems.length) return fromItems;
  return [...data.files].filter(isImageFile);
}

/**
 * Extracts dropped image files from a drag-and-drop `DataTransfer`.
 * Returns an empty array if any dropped item is a directory or non-image file,
 * so non-image drops keep default editor behavior.
 */
export function droppedImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.items?.length) {
    const fileItems = [...data.items].filter((item) => item.kind === "file");
    if (fileItems.length) {
      const files: File[] = [];
      for (const item of fileItems) {
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory) return [];
        const file = item.getAsFile();
        if (!file || !isImageFile(file)) return [];
        files.push(file);
      }
      return files;
    }
  }
  const files = [...data.files];
  if (!files.length || !files.every(isImageFile)) return [];
  return files;
}

/** Whether a `dragover` payload consists exclusively of image files. */
export function hasDraggedImages(data: DataTransfer | null): boolean {
  if (!data) return false;
  const fileItems = [...(data.items ?? [])].filter(
    (item) => item.kind === "file",
  );
  return (
    fileItems.length > 0 &&
    fileItems.every((item) => item.type.toLowerCase().startsWith("image/"))
  );
}
