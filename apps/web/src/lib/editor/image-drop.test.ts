import { describe, expect, test } from "bun:test";

import {
  clipboardImageFiles,
  droppedImageFiles,
  hasDraggedImages,
} from "./image-drop";

function makeDataTransfer({
  items = [],
  files = [],
}: {
  items?: Array<{
    kind: string;
    type: string;
    file?: File | null;
    isDirectory?: boolean;
  }>;
  files?: File[];
}): DataTransfer {
  return {
    items: items.map((item) => ({
      kind: item.kind,
      type: item.type,
      getAsFile: () => item.file ?? null,
      webkitGetAsEntry: () =>
        item.isDirectory ? ({ isDirectory: true } as FileSystemEntry) : null,
    })) as unknown as DataTransferItemList,
    files: files as unknown as FileList,
  } as DataTransfer;
}

describe("clipboardImageFiles", () => {
  test("extracts pasted image files and ignores non-image items", () => {
    const png = new File(["png"], "image.png", { type: "image/png" });
    const data = makeDataTransfer({
      items: [
        { kind: "string", type: "text/plain" },
        { kind: "file", type: "image/png", file: png },
      ],
    });
    expect(clipboardImageFiles(data)).toEqual([png]);
  });

  test("returns empty for plain text paste", () => {
    const data = makeDataTransfer({
      items: [{ kind: "string", type: "text/plain" }],
    });
    expect(clipboardImageFiles(data)).toEqual([]);
  });
});

describe("droppedImageFiles", () => {
  test("extracts multiple dropped image files", () => {
    const a = new File(["a"], "a.png", { type: "image/png" });
    const b = new File(["b"], "b.jpg", { type: "image/jpeg" });
    const data = makeDataTransfer({
      items: [
        { kind: "file", type: "image/png", file: a },
        { kind: "file", type: "image/jpeg", file: b },
      ],
    });
    expect(droppedImageFiles(data)).toEqual([a, b]);
  });

  test("returns empty when a non-image file or directory is dropped", () => {
    const png = new File(["a"], "a.png", { type: "image/png" });
    const tex = new File(["\\section{Hi}"], "intro.tex", {
      type: "text/plain",
    });
    expect(
      droppedImageFiles(
        makeDataTransfer({
          items: [
            { kind: "file", type: "image/png", file: png },
            { kind: "file", type: "text/plain", file: tex },
          ],
        }),
      ),
    ).toEqual([]);
    expect(
      droppedImageFiles(
        makeDataTransfer({
          items: [{ kind: "file", type: "", file: null, isDirectory: true }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("hasDraggedImages", () => {
  test("returns true only when all dragged file items are images", () => {
    expect(
      hasDraggedImages(
        makeDataTransfer({
          items: [{ kind: "file", type: "image/png" }],
        }),
      ),
    ).toBe(true);
    expect(
      hasDraggedImages(
        makeDataTransfer({
          items: [
            { kind: "file", type: "image/png" },
            { kind: "file", type: "text/plain" },
          ],
        }),
      ),
    ).toBe(false);
    expect(hasDraggedImages(makeDataTransfer({}))).toBe(false);
  });
});
