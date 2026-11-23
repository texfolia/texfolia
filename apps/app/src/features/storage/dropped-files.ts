export type DroppedFile = { path: string[]; file: File };

// Entries must be taken during the drop event; the DataTransfer is emptied
// once the handler returns, so callers pass the result of this function on.
export function droppedEntries(data: DataTransfer) {
  const entries = [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? item.getAsFile());
  return entries.filter((entry) => entry !== null);
}

export async function readDroppedFiles(
  entries: Array<FileSystemEntry | File>,
): Promise<DroppedFile[]> {
  const result: DroppedFile[] = [];
  async function visit(entry: FileSystemEntry, path: string[]) {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      result.push({ path: [...path, entry.name], file });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns results in batches until it yields an empty one.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (!batch.length) break;
      for (const child of batch) await visit(child, [...path, entry.name]);
    }
  }
  for (const entry of entries)
    if (entry instanceof File) result.push({ path: [entry.name], file: entry });
    else await visit(entry, []);
  return result;
}
