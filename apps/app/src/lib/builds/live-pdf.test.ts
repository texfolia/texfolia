import { expect, test } from "bun:test";

import { LivePdf } from "./live-pdf";

const chunk = (size: number, value: number) => new Uint8Array(size).fill(value);
const pdf = (chunks: Uint8Array[]) => {
  const bytes = new Uint8Array(Buffer.concat(chunks));
  const opened: number[] = [];
  const live = new LivePdf(async (offset) => {
    opened.push(offset);
    return new Blob([bytes.slice(offset)]).stream();
  });
  return { live, bytes, opened };
};
const collect = async (body: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(body).arrayBuffer());

test("viewers that keep up never touch storage, even when saving fails", async () => {
  const chunks = [chunk(100, 1), chunk(200, 2), chunk(300, 3)];
  const { live, bytes, opened } = pdf(chunks);
  const views = [collect(live.read()), collect(live.read())];
  for (const part of chunks) {
    const reused = part.slice();
    live.write(reused);
    // The archive reuses its buffers.
    reused.fill(0);
    await Bun.sleep(0);
  }
  live.complete(Promise.reject(new Error("storage down")));
  for (const view of views) expect(await view).toEqual(bytes);
  expect(opened).toEqual([]);
});

test("a late viewer waits for the saved copy and reads all of it", async () => {
  const { live, bytes, opened } = pdf([chunk(500, 7)]);
  live.write(bytes);
  const view = collect(live.read());
  const saved = Promise.withResolvers<void>();
  live.complete(saved.promise);
  await Bun.sleep(1);
  expect(opened).toEqual([]);
  saved.resolve();
  expect(await view).toEqual(bytes);
  expect(opened).toEqual([0]);
});

test("a slow viewer is dropped from memory and resumes from the saved copy", async () => {
  const chunks = Array.from({ length: 80 }, (_, index) =>
    chunk(64 * 1024, index),
  );
  const { live, bytes, opened } = pdf(chunks);
  const reader = live.read().getReader();
  const first = reader.read();
  for (const part of chunks) live.write(part);
  live.complete(Promise.resolve());
  const received = [(await first).value!];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received.push(value);
  }
  expect(new Uint8Array(Buffer.concat(received))).toEqual(bytes);
  // Only a bounded prefix was held for this viewer.
  expect(opened).toHaveLength(1);
  expect(opened[0]).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
});

test("a PDF cut short or never saved errors its viewers instead of ending", async () => {
  const cut = pdf([chunk(10, 1)]).live;
  const live = collect(cut.read());
  cut.write(chunk(10, 1));
  const viewers = Promise.allSettled([live, collect(cut.read())]);
  cut.fail(new Error("Truncated archive"));
  expect((await viewers).map(({ status }) => status)).toEqual([
    "rejected",
    "rejected",
  ]);

  const unsaved = pdf([chunk(10, 1)]).live;
  unsaved.write(chunk(10, 1));
  const viewer = collect(unsaved.read());
  unsaved.complete(Promise.reject(new Error("storage down")));
  await expect(viewer).rejects.toThrow();
});

test("a viewer that leaves neither blocks the others nor opens storage", async () => {
  const { live, bytes, opened } = pdf([chunk(10, 1), chunk(10, 2)]);
  const leaving = live.read().getReader();
  const pending = leaving.read();
  const staying = collect(live.read());
  await leaving.cancel();
  expect((await pending).done).toBe(true);
  live.write(bytes.slice(0, 10));
  live.write(bytes.slice(10));
  live.complete(Promise.resolve());
  expect(await staying).toEqual(bytes);
  expect(opened).toEqual([]);
});
