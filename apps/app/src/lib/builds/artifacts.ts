import type { ArtifactManifest } from "@texfolia/contracts";
import type { ArchiveSink, CompileSinks } from "@texfolia/contracts/compiler";

import { LivePdf } from "./live-pdf";
import type { ObjectStore } from "./types";

// R2 allows six simultaneous connections per request.
export const storageConcurrency = 6;

const outputName = (mainFile: string) =>
  mainFile
    .split("/")
    .at(-1)!
    .replace(/\.tex$/, "");
export const pdfPath = (mainFile: string) => `${outputName(mainFile)}.pdf`;
export const logPath = (mainFile: string) => `${outputName(mainFile)}.log`;

type File = ArtifactManifest["files"][number];

/** Streams one build attempt's artifacts to storage as the compiler sends them. */
export type ArtifactWriter = Required<CompileSinks> & {
  /** One saved file, or null when the attempt did not save it. */
  saved(path: string): Promise<File | null>;
  /** Every file, once all of them are saved. Adds the log when there is none. */
  finish(log: string): Promise<File[]>;
  /** Settles when nothing is being written any more. */
  settled(): Promise<void>;
};

export function createArtifactWriter(options: {
  store: ObjectStore;
  projectId: string;
  mainFile: string;
  keys: { preview: string; cache: string };
  signal: AbortSignal;
  onPdf: (pdf: LivePdf) => void;
}): ArtifactWriter {
  const { store, signal } = options;
  const generation = crypto.randomUUID();
  const inFlight = new Set<Promise<void>>();
  const files = new Map<string, File & { upload: Promise<void> }>();
  const uploads: Promise<void>[] = [];

  // Storage failures surface from `finish` and `saved`, never from the sink:
  // they must not cut off the rest of the response or a live viewer.
  async function upload(key: string, size: number, create: boolean) {
    // Each upload drains as its bytes arrive, so only commits overlap.
    while (inFlight.size >= storageConcurrency) await Promise.race(inFlight);
    const { body, saved } = store.upload(key, size, { create });
    const writer = body.getWriter();
    const done = saved.then((ok) => {
      if (!ok) throw new Error("Build artifact was not saved");
    });
    const settled = done.then(
      () => {},
      () => {
        stopped = true;
      },
    );
    let stopped = false;
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));
    uploads.push(done);
    // Storage that stops reading early must not stall the archive.
    const push = async (action: () => Promise<void>) => {
      if (stopped) return;
      const pending = action();
      pending.catch(() => {});
      await Promise.race([pending, done]).catch(() => {
        stopped = true;
      });
    };
    const sink: Required<ArchiveSink> = {
      write: (bytes) => push(() => writer.write(bytes)),
      close: () => push(() => writer.close()),
      abort: (cause) => void writer.abort(cause).catch(() => {}),
    };
    return { sink, done };
  }

  async function file(path: string, size: number) {
    const key = `projects/${options.projectId}/builds/${generation}/${path}`;
    const { sink, done } = await upload(key, size, true);
    files.set(path, { path, key, sizeBytes: size, upload: done });
    return { key, sink, done };
  }
  const manifestFile = ({ path, key, sizeBytes }: File): File => ({
    path,
    key,
    sizeBytes,
  });
  const settled = async () => void (await Promise.allSettled(uploads));

  return {
    async pdf(size) {
      const { key, sink, done } = await file(pdfPath(options.mainFile), size);
      const live = new LivePdf(
        async (offset) => (await store.open(key, offset))?.body ?? null,
      );
      options.onPdf(live);
      return {
        async write(bytes) {
          live.write(bytes);
          await sink.write(bytes);
        },
        async close() {
          live.complete(done);
          await sink.close();
        },
        abort(cause) {
          live.fail(cause);
          sink.abort(cause);
        },
      };
    },
    file: async (path, size) => (await file(path, size)).sink,
    preview: async (size) =>
      (await upload(options.keys.preview, size, false)).sink,
    // A superseded build must not replace the cache of the build after it.
    cache: async (size) =>
      signal.aborted
        ? { write: () => {} }
        : (await upload(options.keys.cache, size, false)).sink,
    async saved(path) {
      const found = files.get(path);
      if (!found) return null;
      return found.upload.then(
        () => manifestFile(found),
        () => null,
      );
    },
    async finish(log) {
      const path = logPath(options.mainFile);
      if (!files.has(path)) {
        const bytes = new TextEncoder().encode(log);
        const { sink } = await file(path, bytes.byteLength);
        if (bytes.byteLength) await sink.write(bytes);
        await sink.close?.();
      }
      await settled();
      await Promise.all(uploads);
      if (!files.has(pdfPath(options.mainFile)))
        throw new Error("Build has no PDF artifact");
      return [...files.values()].map(manifestFile);
    },
    settled,
  };
}
