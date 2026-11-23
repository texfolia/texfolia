import { expect, test } from "bun:test";

import { readDroppedFiles } from "./dropped-files";

function file(name: string) {
  const value = new File([name], name);
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (resolve: (file: File) => void) => resolve(value),
  } as unknown as FileSystemEntry;
}

function folder(name: string, ...batches: FileSystemEntry[][]) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      const pending = [...batches, []];
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) =>
          resolve(pending.shift() ?? []),
      };
    },
  } as unknown as FileSystemEntry;
}

test("dropped folders are read in full, keeping their relative paths", async () => {
  const dropped = await readDroppedFiles([
    folder(
      "figures",
      [file("a.png"), folder("plots", [file("b.pdf")])],
      [file("c.png")],
    ),
    new File(["main"], "main.tex"),
  ]);
  expect(dropped.map(({ path }) => path.join("/"))).toEqual([
    "figures/a.png",
    "figures/plots/b.pdf",
    "figures/c.png",
    "main.tex",
  ]);
  expect(await dropped[3]?.file.text()).toBe("main");
});
