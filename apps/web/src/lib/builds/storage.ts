import type { ObjectStore, SourceStore } from "./types";

// The Workers adapters for a coordinator's storage.

export function artifactStore(bucket: R2Bucket): ObjectStore {
  const open: ObjectStore["open"] = async (key, offset = 0) => {
    const object = await bucket.get(
      key,
      offset ? { range: { offset } } : undefined,
    );
    return object ? { size: object.size, body: object.body } : null;
  };
  const createOptions = (key: string) => ({
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: key.endsWith(".pdf")
      ? { contentType: "application/pdf" }
      : undefined,
  });
  return {
    open,
    read: async (key) => (await open(key))?.body ?? null,
    async create(key, value) {
      return (await bucket.put(key, value, createOptions(key))) !== null;
    },
    upload(key, size, { create }) {
      // R2 needs the length of a streamed body up front.
      const { readable, writable } = new FixedLengthStream(size);
      return {
        body: writable,
        saved: bucket
          .put(key, readable, create ? createOptions(key) : undefined)
          .then((object) => object !== null),
      };
    },
    async write(key, value) {
      await bucket.put(key, value);
    },
    remove: (key) => bucket.delete(key),
    async *keys(prefix, before) {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        for (const object of page.objects)
          if (before === undefined || object.uploaded.getTime() < before)
            yield object.key;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },
  };
}

export function savedSources(bucket: R2Bucket): SourceStore["saved"] {
  return {
    size: async (key) => (await bucket.head(key))?.size ?? null,
    async open(key) {
      const object = await bucket.get(key);
      return object ? { size: object.size, body: object.body } : null;
    },
  };
}

// Durable Object SQLite rows hold at most 2 MB.
const partBytes = 1024 * 1024;

export function draftSources(
  storage: DurableObjectStorage,
): SourceStore["drafts"] {
  const { sql } = storage;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS drafts (hash TEXT NOT NULL, part INTEGER NOT NULL, size INTEGER NOT NULL, value BLOB NOT NULL, PRIMARY KEY (hash, part))",
  );
  const size = (hash: string) =>
    sql
      .exec<{ size: number }>(
        "SELECT size FROM drafts WHERE hash = ? AND part = 0",
        hash,
      )
      .toArray()[0]?.size ?? null;
  return {
    size,
    read(hash) {
      const total = size(hash);
      if (total === null) return null;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const row of sql.exec<{ value: ArrayBuffer }>(
        "SELECT value FROM drafts WHERE hash = ? ORDER BY part",
        hash,
      )) {
        bytes.set(new Uint8Array(row.value), offset);
        offset += row.value.byteLength;
      }
      return bytes;
    },
    write(hash, bytes) {
      if (size(hash) !== null) return;
      storage.transactionSync(() => {
        for (
          let part = 0;
          part === 0 || part * partBytes < bytes.length;
          part++
        )
          sql.exec(
            "INSERT INTO drafts VALUES (?, ?, ?, ?)",
            hash,
            part,
            bytes.length,
            bytes.slice(part * partBytes, (part + 1) * partBytes),
          );
      });
    },
    retain(hashes) {
      for (const { hash } of sql
        .exec<{ hash: string }>("SELECT hash FROM drafts WHERE part = 0")
        .toArray())
        if (!hashes.has(hash))
          sql.exec("DELETE FROM drafts WHERE hash = ?", hash);
    },
  };
}
