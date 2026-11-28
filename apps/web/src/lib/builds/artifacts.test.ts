import { expect, test } from "bun:test";

import { fill } from "../../../test/builds/engine";
import { memoryStore, type StoredObject } from "../../../test/builds/stores";
import { createArtifactWriter, storageConcurrency } from "./artifacts";
import type { LivePdf } from "./live-pdf";
import type { ObjectStore } from "./types";

function harness(change: (store: ObjectStore) => ObjectStore = (s) => s) {
  const objects = new Map<string, StoredObject>();
  const controller = new AbortController();
  let live: LivePdf | undefined;
  const writer = createArtifactWriter({
    store: change(memoryStore(objects)),
    projectId: "p",
    mainFile: "chapters/main.tex",
    keys: { preview: "preview.png", cache: "cache" },
    signal: controller.signal,
    onPdf: (pdf) => {
      live = pdf;
    },
  });
  return {
    writer,
    objects,
    controller,
    live: () => live!,
    stored: (key: string) =>
      new TextDecoder().decode(objects.get(key)?.bytes ?? new Uint8Array()),
  };
}

test("every part is saved under one generation, with a log when there is none", async () => {
  const { writer, objects, stored } = harness();
  await fill(writer.pdf(4), "%PDF");
  await fill(writer.preview(3), "png");
  await fill(writer.file("main.aux", 3), "aux");
  await fill(writer.file("empty", 0), "");
  await fill(writer.cache(5), "cache");
  const files = await writer.finish("log");
  expect(files.map(({ path, sizeBytes }) => [path, sizeBytes])).toEqual([
    ["main.pdf", 4],
    ["main.aux", 3],
    ["empty", 0],
    ["main.log", 3],
  ]);
  expect(new Set(files.map(({ key }) => key.split("/")[3])).size).toBe(1);
  expect(stored(files[0]!.key)).toBe("%PDF");
  expect(stored("preview.png")).toBe("png");
  expect(stored("cache")).toBe("cache");
  expect(objects.size).toBe(6);
});

test("a storage failure fails the build but neither the archive nor a live viewer", async () => {
  const { writer, live } = harness((store) => ({
    ...store,
    upload: (key, size, options) =>
      key.endsWith(".pdf")
        ? {
            // Like R2, it stops reading as soon as it fails.
            body: new WritableStream({ write: () => new Promise(() => {}) }),
            saved: Promise.reject(new Error("R2 unavailable")),
          }
        : store.upload(key, size, options),
  }));
  const pdf = await writer.pdf(8);
  const viewer = new Response(live().read()).text();
  await pdf.write(new TextEncoder().encode("%PDF"));
  await pdf.write(new TextEncoder().encode("tail"));
  await pdf.close?.();
  await fill(writer.file("main.aux", 3), "aux");
  expect(await viewer).toBe("%PDFtail");
  await expect(writer.finish("log")).rejects.toThrow("R2 unavailable");
  expect(await writer.saved("main.pdf")).toBeNull();
  expect(await writer.saved("main.aux")).toMatchObject({ sizeBytes: 3 });
});

test("an entry cut short is never saved", async () => {
  const { writer, objects } = harness();
  const sink = await writer.file("main.log", 10);
  await sink.write(new TextEncoder().encode("half"));
  sink.abort?.(new Error("Truncated archive"));
  await writer.settled();
  expect(objects.size).toBe(0);
  expect(await writer.saved("main.log")).toBeNull();
});

test("a build without its PDF cannot finish, and a superseded one leaves the cache alone", async () => {
  const { writer, controller, objects } = harness();
  await fill(writer.file("main.aux", 3), "aux");
  controller.abort();
  await fill(writer.cache(5), "cache");
  expect(objects.has("cache")).toBe(false);
  await expect(writer.finish("log")).rejects.toThrow("no PDF");
});

test("uncommitted uploads are bounded, however many files a build has", async () => {
  let open = 0;
  let most = 0;
  const { writer } = harness((store) => ({
    ...store,
    upload(key, size, options) {
      most = Math.max(most, ++open);
      const { body, saved } = store.upload(key, size, options);
      return {
        body,
        saved: saved.then(async (ok) => {
          await Bun.sleep(1);
          open--;
          return ok;
        }),
      };
    },
  }));
  await fill(writer.pdf(4), "%PDF");
  for (let index = 0; index < 40; index++)
    await fill(writer.file(`${index}`, 1), "x");
  expect(await writer.finish("log")).toHaveLength(42);
  expect(most).toBe(storageConcurrency);
});
