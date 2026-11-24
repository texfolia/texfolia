// A minimal ustar codec for the compile wire. Every entry name is short ASCII
// and every size is known up front, so neither side needs long-name headers.
const blockBytes = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Bytes = Uint8Array<ArrayBuffer>;

const padding = (size: number) =>
  (blockBytes - (size % blockBytes)) % blockBytes;

/** The bytes one entry occupies, including its header and padding. */
export const archiveEntryBytes = (size: number) =>
  blockBytes + size + padding(size);
/** The zero blocks that end an archive. */
export const archiveEndBytes = 2 * blockBytes;

function header(name: string, size: number): Bytes {
  const bytes = new Uint8Array(blockBytes);
  const write = (text: string, offset: number) =>
    bytes.set(encoder.encode(text), offset);
  if (encoder.encode(name).length > 100)
    throw new Error("Archive entry name is too long");
  write(name, 0);
  write("0000600\0", 100);
  write("0000000\0", 108);
  write("0000000\0", 116);
  write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  write("00000000000\0", 136);
  write("        ", 148);
  write("0", 156);
  write("ustar\0", 257);
  write("00", 263);
  const checksum = bytes.reduce((sum, byte) => sum + byte, 0);
  write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return bytes;
}

export type ArchiveEntry = {
  name: string;
  size: number;
  content:
    | Uint8Array
    | (() => Promise<Uint8Array | ReadableStream<Uint8Array>>);
};

/**
 * Streams entries in order. A lazy entry is loaded when the archive reaches it
 * and must produce exactly `size` bytes.
 */
export function writeArchive(entries: readonly ArchiveEntry[]) {
  async function* chunks() {
    for (const entry of entries) {
      yield header(entry.name, entry.size);
      const content =
        typeof entry.content === "function"
          ? await entry.content()
          : entry.content;
      let written = 0;
      if (content instanceof Uint8Array) {
        written = content.byteLength;
        if (written) yield content;
      } else {
        const reader = content.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            written += value.byteLength;
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      if (written !== entry.size)
        throw new Error(`Archive entry ${entry.name} changed size`);
      if (padding(entry.size)) yield new Uint8Array(padding(entry.size));
    }
    yield new Uint8Array(archiveEndBytes);
  }
  const iterator = chunks();
  return {
    size: entries.reduce(
      (total, entry) => total + archiveEntryBytes(entry.size),
      archiveEndBytes,
    ),
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel() {
        await iterator.return(undefined);
      },
    }),
  };
}

const octal = (bytes: Uint8Array, offset: number, length: number) => {
  const text = decoder
    .decode(bytes.subarray(offset, offset + length))
    .replace(/[\0 ]+$/, "");
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : NaN;
};

/**
 * Reads entries in order and passes each one to `visit`. A visitor may take an
 * entry's chunks as they arrive; every entry is also returned whole. Throws on
 * a truncated archive, so a response cut short never looks complete.
 */
export async function readArchive(
  body: ReadableStream<Uint8Array>,
  options: {
    maxBytes: number;
    visit?: (entry: { name: string; size: number }) =>
      | {
          chunk: (bytes: Uint8Array) => void;
          end: () => void;
          error: (cause: unknown) => void;
        }
      | undefined;
  },
) {
  const reader = body.getReader();
  let pending: Uint8Array = new Uint8Array();
  let total = 0;
  const next = async () => {
    const { done, value } = await reader.read();
    if (done) throw new Error("Truncated archive");
    total += value.byteLength;
    if (total > options.maxBytes) throw new Error("Archive exceeds its limit");
    pending = value;
  };
  const take = async (size: number, onChunk?: (bytes: Uint8Array) => void) => {
    const result = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      if (!pending.byteLength) await next();
      const part = pending.subarray(0, size - filled);
      result.set(part, filled);
      filled += part.byteLength;
      pending = pending.subarray(part.byteLength);
      if (part.byteLength) onChunk?.(part);
    }
    return result;
  };
  const entries = new Map<string, Bytes>();
  try {
    while (true) {
      const block = await take(blockBytes);
      if (block.every((byte) => byte === 0)) return entries;
      const end = block.indexOf(0);
      const name = decoder.decode(
        block.subarray(0, Math.min(end < 0 ? 100 : end, 100)),
      );
      const size = octal(block, 124, 12);
      const checksum = block.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
        0,
      );
      if (
        !name ||
        block[156] !== 0x30 ||
        !Number.isSafeInteger(size) ||
        octal(block, 148, 8) !== checksum ||
        entries.has(name)
      )
        throw new Error("Invalid archive entry");
      if (size > options.maxBytes) throw new Error("Archive exceeds its limit");
      const visitor = options.visit?.({ name, size });
      try {
        entries.set(name, await take(size, visitor?.chunk));
        visitor?.end();
      } catch (error) {
        visitor?.error(error);
        throw error;
      }
      await take(padding(size));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
