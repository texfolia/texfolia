import type { SyncedProject } from "#/lib/builds/source-sync";
import type { Engine, ObjectStore, SourceStore } from "#/lib/builds/types";

export type StoredObject = { bytes: Uint8Array; uploaded: number };

const encode = (value: string | Uint8Array) =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

/** Like R2, saves a streamed body only once exactly `size` bytes arrived. */
export function bufferedUpload(
  size: number,
  save: (bytes: Uint8Array) => Promise<boolean>,
): ReturnType<ObjectStore["upload"]> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  return {
    body: writable,
    saved: new Response(readable).arrayBuffer().then((buffer) => {
      if (buffer.byteLength !== size)
        throw new Error("Upload has the wrong size");
      return save(new Uint8Array(buffer));
    }),
  };
}

export function memoryStore(
  objects = new Map<string, StoredObject>(),
): ObjectStore {
  const put = (key: string, value: string | Uint8Array) => {
    objects.set(key, { bytes: encode(value), uploaded: Date.now() });
  };
  const open: ObjectStore["open"] = async (key, offset = 0) => {
    const object = objects.get(key);
    return object
      ? {
          size: object.bytes.length,
          body: new Blob([new Uint8Array(object.bytes).slice(offset)]).stream(),
        }
      : null;
  };
  const create: ObjectStore["create"] = async (key, value) => {
    if (objects.has(key)) return false;
    put(key, value);
    return true;
  };
  return {
    open,
    read: async (key) => (await open(key))?.body ?? null,
    create,
    upload: (key, size, options) =>
      bufferedUpload(size, async (bytes) => {
        if (options.create) return create(key, bytes);
        put(key, bytes);
        return true;
      }),
    async write(key, value) {
      put(key, value);
    },
    async remove(key) {
      objects.delete(key);
    },
    async *keys(prefix, before = Infinity) {
      for (const [key, object] of objects)
        if (key.startsWith(prefix) && object.uploaded < before) yield key;
    },
  };
}

export function memorySources(
  saved = new Map<string, Uint8Array>(),
  drafts = new Map<string, Uint8Array>(),
): SourceStore {
  const copy = (bytes: Uint8Array | undefined) =>
    bytes ? new Uint8Array(bytes) : null;
  return {
    saved: {
      size: async (key) => saved.get(key)?.length ?? null,
      async open(key) {
        const bytes = copy(saved.get(key));
        return bytes
          ? { size: bytes.length, body: new Blob([bytes]).stream() }
          : null;
      },
    },
    drafts: {
      size: (hash) => drafts.get(hash)?.length ?? null,
      read: (hash) => copy(drafts.get(hash)),
      write: (hash, bytes) => {
        drafts.set(hash, bytes);
      },
      retain: (hashes) => {
        for (const hash of drafts.keys())
          if (!hashes.has(hash)) drafts.delete(hash);
      },
    },
  };
}

/** The text of one source, read the way an engine reads it. */
export async function sourceText(
  project: SyncedProject,
  context: Pick<Parameters<Engine>[1], "readSource">,
  path = "main.tex",
) {
  const file = project.files[path];
  if (!file) throw new Error(`Missing source ${path}`);
  return new Response(await context.readSource(file)).text();
}

/** A one-file project whose content is never read. */
export const emptyProject: SyncedProject = {
  mainFile: "main.tex",
  revision: 0,
  files: { "main.tex": { hash: "0".repeat(64), size: 0 } },
};
