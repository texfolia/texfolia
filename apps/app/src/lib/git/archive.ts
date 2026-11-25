// The stored form of a working clone: one R2 object that holds the raw files of
// its `.git` folder. A fixed header gives the length of a JSON list of paths and
// sizes, which the files' bytes follow in the same order.
import { z } from "zod";

import type { SourceBucket } from "#/lib/storage/server";

const magic = new TextEncoder().encode("TFGIT001");
const headerBytes = magic.byteLength + 4;
// The list names every loose object, so it is bounded separately from them.
const maxListBytes = 8 * 1024 * 1024;
const listSchema = z.array(
  z.tuple([z.string().min(1), z.number().int().nonnegative()]),
);

type GitFileEntry = [path: string, value: Uint8Array<ArrayBuffer>];

/** Streams the files to R2, so saving holds no second copy of them. */
export async function saveArchive(
  bucket: Pick<SourceBucket, "put">,
  key: string,
  files: Iterable<GitFileEntry>,
) {
  const entries = [...files];
  const list = new TextEncoder().encode(
    JSON.stringify(entries.map(([path, value]) => [path, value.byteLength])),
  );
  if (list.byteLength > maxListBytes)
    throw new Error("Git history has too many objects.");
  const header = new Uint8Array(headerBytes);
  header.set(magic);
  new DataView(header.buffer).setUint32(magic.byteLength, list.byteLength);
  const parts = [header, list, ...entries.map(([, value]) => value)];
  const { readable, writable } = new FixedLengthStream(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  const write = async () => {
    const writer = writable.getWriter();
    try {
      for (const part of parts) if (part.byteLength) await writer.write(part);
      await writer.close();
    } catch (error) {
      // The upload reports why it stopped reading.
      await writer.abort(error).catch(() => {});
    }
  };
  await Promise.all([bucket.put(key, readable), write()]);
}

/** Reads an archive file by file, each into a buffer of its own. */
export async function* readArchive(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<GitFileEntry> {
  const reader = body.getReader();
  let chunk: Uint8Array = new Uint8Array();
  const read = async (size: number) => {
    const value = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      if (!chunk.byteLength) {
        const next = await reader.read();
        if (next.done) throw new Error("Invalid repository data");
        chunk = next.value;
      }
      const part = chunk.subarray(0, size - filled);
      value.set(part, filled);
      filled += part.byteLength;
      chunk = chunk.subarray(part.byteLength);
    }
    return value;
  };
  try {
    const header = await read(headerBytes);
    const listBytes = new DataView(header.buffer).getUint32(magic.byteLength);
    if (
      magic.some((byte, index) => header[index] !== byte) ||
      listBytes > maxListBytes
    )
      throw new Error("Invalid repository data");
    const list = listSchema.parse(
      JSON.parse(new TextDecoder().decode(await read(listBytes))),
    );
    if (list.reduce((total, [, size]) => total + size, 0) > maxBytes)
      throw new Error("Invalid repository data");
    for (const [path, size] of list) yield [path, await read(size)];
  } finally {
    await reader.cancel().catch(() => {});
  }
}
