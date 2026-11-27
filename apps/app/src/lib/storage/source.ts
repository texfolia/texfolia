import { z } from "zod";

export const maxSourceFileBytes = 10 * 1024 * 1024;
export const maxSourceProjectBytes = 50 * 1024 * 1024;
export const sourceContentSchema = z
  .string()
  .max(4 * Math.ceil(maxSourceFileBytes / 3))
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine((value) => value.length % 4 === 0, "Invalid base64 content");

export type SourceFiles = Record<string, string | { base64: string }>;

export function sourceFileKind(file: {
  name: string;
  type: string;
}): "text" | "binary" {
  return /\.(tex|ltx|latex|bib|sty|cls|clo|bst|bbx|cbx|lbx|cfg|def|json|yaml|yml|toml|ini|csv|tsv|md|markdown|txt|svg|xml|lua|py|r|jl|sh|js|ts|css|html)$/i.test(
    file.name,
  ) || file.type.startsWith("text/")
    ? "text"
    : "binary";
}

// Node's base64 is native on the server. Browsers have no Buffer.
const native = typeof Buffer === "undefined" ? null : Buffer;

export function encodeSource(bytes: Uint8Array) {
  if (native)
    return native
      .from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .toString("base64");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function decodeSource(base64: string): Uint8Array<ArrayBuffer> {
  if (native) {
    // Small buffers share a pool, so return a plain view of these bytes only.
    const { buffer, byteOffset, byteLength } = native.from(base64, "base64");
    return new Uint8Array(buffer, byteOffset, byteLength);
  }
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

export const saveSourceSchema = z.object({
  projectId: z.uuid(),
  nodeId: z.uuid(),
  expectedObjectKey: z.string().nullable(),
  content: sourceContentSchema,
});

/** Extracts the SHA-256 content hash from a source object key (`<uuid>-<sha256>` or legacy `<sha256>`). */
export function sourceHashFromKey(
  objectKey: string | null | undefined,
): string | null {
  if (!objectKey) return null;
  const name = objectKey.slice(objectKey.lastIndexOf("/") + 1);
  const match = /(?:^|-)([0-9a-f]{64})$/.exec(name);
  return match?.[1] ?? null;
}
