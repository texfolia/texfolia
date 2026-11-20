import { sourcePathSchema } from "@texfolia/contracts";
import { z } from "zod";

import { decodeBase64, encodeBase64 } from "./artifacts";
import { artifactContentSchema, HttpError, maxProjectBytes } from "./project";
import type { ObjectStore } from "./types";

const sourceHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const maxSourceSyncBytes = 64 * 1024 * 1024;
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const sourceContentSchema = z.union([z.string(), artifactContentSchema]);
export const sourceDeltaSchema = z
  .object({
    mainFile: sourcePathSchema.refine((value) => value.endsWith(".tex")),
    baseRevision: revisionSchema,
    revision: revisionSchema,
    files: z.record(
      sourcePathSchema,
      z.object({
        hash: sourceHashSchema,
        content: sourceContentSchema.optional(),
      }),
    ),
    deleted: z.array(sourcePathSchema).max(200),
    resync: z.boolean().optional(),
  })
  .superRefine((delta, ctx) => {
    if (
      delta.revision <= delta.baseRevision ||
      Object.keys(delta.files).length > 200 ||
      new Set(delta.deleted).size !== delta.deleted.length ||
      delta.deleted.some((path) => Object.hasOwn(delta.files, path))
    )
      ctx.addIssue({ code: "custom", message: "Invalid source delta" });
  });
export type SourceDelta = z.infer<typeof sourceDeltaSchema>;
export const syncedProjectSchema = z.object({
  kind: z.literal("synced"),
  mainFile: sourcePathSchema,
  revision: revisionSchema,
  files: z.record(
    sourcePathSchema,
    z.object({
      hash: sourceHashSchema,
      encoding: z.enum(["text", "base64"]),
      size: z.number().int().nonnegative(),
    }),
  ),
});
export type SyncedProject = z.infer<typeof syncedProjectSchema>;
export type SourceContent = z.infer<typeof sourceContentSchema>;

export async function sourceHash(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function sourceBytes(content: SourceContent) {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : decodeBase64(content.base64);
}
export const sourceObjectKey = (projectId: string, hash: string) =>
  `projects/${projectId}/source-objects/${hash}`;

export class SourceResyncError extends HttpError {
  constructor(public revision: number) {
    super(409, "Source resync required");
  }
}

export async function readSource(
  store: ObjectStore,
  projectId: string,
  file: SyncedProject["files"][string],
): Promise<SourceContent> {
  const body = await store.read(sourceObjectKey(projectId, file.hash));
  if (!body) throw new Error("Saved source object is missing");
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  if ((await sourceHash(bytes)) !== file.hash)
    throw new Error("Saved source hash mismatch");
  return file.encoding === "text"
    ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    : { base64: encodeBase64(bytes) };
}

export async function applySourceDelta(options: {
  delta: SourceDelta;
  previous: SyncedProject | null;
  store: ObjectStore;
  projectId: string;
}) {
  const { delta, previous, store, projectId } = options;
  const revision = previous?.revision ?? 0;
  if (!delta.resync && (!previous || delta.baseRevision !== revision))
    throw new SourceResyncError(revision);
  if (delta.resync && delta.baseRevision !== revision)
    throw new SourceResyncError(revision);
  const files = new Map<string, SyncedProject["files"][string]>(
    Object.entries(delta.resync ? {} : (previous?.files ?? {})),
  );
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const file of Object.values(delta.files)) {
    if (file.content === undefined) continue;
    const bytes = sourceBytes(file.content);
    if (bytes.length >= maxProjectBytes)
      throw new HttpError(413, "Project exceeds 10 MiB");
    if ((await sourceHash(bytes)) !== file.hash)
      throw new SourceResyncError(revision);
    objects.set(file.hash, bytes);
  }
  for (const path of delta.deleted) files.delete(path);
  for (const [path, file] of Object.entries(delta.files)) {
    const key = sourceObjectKey(projectId, file.hash);
    if (file.content !== undefined) {
      const bytes = objects.get(file.hash)!;
      files.set(path, {
        hash: file.hash,
        encoding: typeof file.content === "string" ? "text" : "base64",
        size: bytes.length,
      });
    } else {
      const object = objects.has(file.hash)
        ? { size: objects.get(file.hash)!.length }
        : await store.head(key);
      if (!object) throw new SourceResyncError(revision);
      files.set(path, {
        hash: file.hash,
        encoding: previous?.files[path]?.encoding ?? "base64",
        size: object.size,
      });
    }
  }
  const paths = [...files.keys()];
  if (
    !paths.length ||
    paths.length > 200 ||
    !files.has(delta.mainFile) ||
    paths.some((path) => paths.some((other) => other.startsWith(`${path}/`)))
  )
    throw new HttpError(400, "Invalid project sources");
  if (
    [...files.values()].reduce((size, file) => size + file.size, 0) >=
    maxProjectBytes
  )
    throw new HttpError(413, "Project exceeds 10 MiB");
  for (const [hash, bytes] of objects) {
    const key = sourceObjectKey(projectId, hash);
    if (!(await store.head(key))) await store.create(key, bytes);
  }
  return {
    kind: "synced",
    mainFile: delta.mainFile,
    revision: delta.revision,
    files: Object.fromEntries(files),
  } satisfies SyncedProject;
}
