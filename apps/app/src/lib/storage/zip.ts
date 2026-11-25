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

// ZIP64 takes over where the original 16-bit and 32-bit fields end.
const max16 = 0xffff;
const max32 = 0xffffffff;

async function writeZip(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  write: (bytes: Bytes) => Promise<void>,
) {
  const directory: Bytes[] = [];
  let offset = 0;
  for await (const { path, open } of entries) {
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
    const distant = offset >= max32;
    const entry = new Uint8Array(46 + name.length + (distant ? 12 : 0));
    const central = new DataView(entry.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, distant ? 45 : 20, true);
    central.setUint16(6, distant ? 45 : 20, true);
    central.setUint16(8, 0x800, true);
    central.setUint16(14, 0x21, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, Math.min(offset, max32), true);
    entry.set(name, 46);
    if (distant) {
      central.setUint16(30, 12, true);
      central.setUint16(46 + name.length, 1, true);
      central.setUint16(48 + name.length, 8, true);
      central.setBigUint64(50 + name.length, BigInt(offset), true);
    }
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
  const count = directory.length;
  if (count >= max16 || directoryBytes >= max32 || offset >= max32) {
    const end64 = new Uint8Array(56 + 20);
    const view64 = new DataView(end64.buffer);
    view64.setUint32(0, 0x06064b50, true);
    view64.setBigUint64(4, 44n, true);
    view64.setUint16(12, 45, true);
    view64.setUint16(14, 45, true);
    view64.setBigUint64(24, BigInt(count), true);
    view64.setBigUint64(32, BigInt(count), true);
    view64.setBigUint64(40, BigInt(directoryBytes), true);
    view64.setBigUint64(48, BigInt(offset), true);
    // Where to find the record above.
    view64.setUint32(56, 0x07064b50, true);
    view64.setBigUint64(64, BigInt(offset + directoryBytes), true);
    view64.setUint32(72, 1, true);
    await write(end64);
  }
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, Math.min(count, max16), true);
  view.setUint16(10, Math.min(count, max16), true);
  view.setUint32(12, Math.min(directoryBytes, max32), true);
  view.setUint32(16, Math.min(offset, max32), true);
  await write(end);
}

/**
 * Streams an uncompressed ZIP, which keeps arbitrary files as they are. Each
 * entry is opened only once the reader has taken the one before it.
 */
export function zipStream(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
): ReadableStream<Bytes> {
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
