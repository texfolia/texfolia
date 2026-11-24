type Bytes = Uint8Array<ArrayBuffer>;
export type ZipEntry = {
  path: string;
  // Called when the archive reaches this entry.
  open: () => Promise<Bytes>;
};

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index++)
    crc = (crc >>> 8) ^ crcTable[(crc ^ data[index]!) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeZip(
  entries: Iterable<ZipEntry>,
  write: (bytes: Bytes) => Promise<void>,
) {
  const directory: Bytes[] = [];
  let offset = 0;
  for (const { path, open } of entries) {
    const name = new TextEncoder().encode(path);
    // The checksum precedes the data, so one entry is held at a time.
    const data = await open();
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(12, 0x21, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const central = new DataView(entry.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x800, true);
    central.setUint16(14, 0x21, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    entry.set(name, 46);
    directory.push(entry);
    offset += local.length + data.length;
    await write(local);
    if (data.length) await write(data);
  }
  let directoryBytes = 0;
  for (const entry of directory) {
    directoryBytes += entry.length;
    await write(entry);
  }
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, directory.length, true);
  view.setUint16(10, directory.length, true);
  view.setUint32(12, directoryBytes, true);
  view.setUint32(16, offset, true);
  await write(end);
}

/**
 * Streams an uncompressed ZIP, which keeps arbitrary files as they are. Each
 * entry is opened only once the reader has taken the one before it.
 */
export function zipStream(entries: Iterable<ZipEntry>): ReadableStream<Bytes> {
  const { readable, writable } = new TransformStream<Bytes, Bytes>();
  const writer = writable.getWriter();
  void writeZip(entries, (bytes) => writer.write(bytes))
    .then(
      () => writer.close(),
      (error: unknown) => writer.abort(error),
    )
    .catch(() => {
      // The reader cancelled.
    });
  return readable;
}

/** Builds an archive in the browser, for a download without a round trip. */
export async function createZip(files: { path: string; blob: Blob }[]) {
  const archive = await new Response(
    zipStream(
      files.map(({ path, blob }) => ({
        path,
        open: async () => new Uint8Array(await blob.arrayBuffer()),
      })),
    ),
  ).blob();
  return new Blob([archive], { type: "application/zip" });
}
