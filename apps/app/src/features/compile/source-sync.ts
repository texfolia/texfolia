import { z } from "zod";

import { decodeSource, sourceContentSchema } from "#/features/storage";

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const compileDeltaSchema = z.object({
  mainFile: z.string(),
  baseRevision: revision,
  revision,
  files: z.record(
    z.string(),
    z.object({
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      content: z
        .union([z.string(), z.object({ base64: sourceContentSchema })])
        .optional(),
    }),
  ),
  deleted: z.array(z.string()).max(200),
});
export type CompileSources = Record<
  string,
  string | { base64: string } | { hash: string }
>;

export async function hashSource(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class ProjectSourceSync {
  private revision = 0;
  private hashes = new Map<string, string>();
  private sequence = 0;
  private acceptedSequence = 0;

  async prepare(mainFile: string, sources: CompileSources) {
    const sequence = ++this.sequence;
    const baseRevision = this.revision;
    const previousHashes = this.hashes;
    const hashes = new Map<string, string>();
    const files: z.infer<typeof compileDeltaSchema>["files"] = {};
    for (const [path, content] of Object.entries(sources)) {
      const hash =
        typeof content === "object" && "hash" in content
          ? content.hash
          : await hashSource(
              typeof content === "string"
                ? new TextEncoder().encode(content)
                : decodeSource(content.base64),
            );
      hashes.set(path, hash);
      if (previousHashes.get(path) !== hash)
        Object.defineProperty(files, path, {
          enumerable: true,
          value: {
            hash,
            ...(typeof content === "object" && "hash" in content
              ? {}
              : { content }),
          },
        });
    }
    return {
      delta: {
        mainFile,
        baseRevision,
        revision: baseRevision + 1,
        files,
        deleted: [...previousHashes.keys()].filter((path) => !hashes.has(path)),
      },
      hashes,
      sequence,
    };
  }

  accept(revision: number, hashes: Map<string, string>, sequence: number) {
    if (sequence <= this.acceptedSequence) return;
    this.acceptedSequence = sequence;
    this.revision = revision;
    this.hashes = hashes;
  }
}
