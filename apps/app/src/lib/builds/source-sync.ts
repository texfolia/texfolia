import { sourcePathSchema } from "@texfolia/contracts";
import { z } from "zod";

import { mapLimit } from "#/lib/map-limit";
import { decodeSource } from "#/lib/storage";

import { storageConcurrency } from "./artifacts";
import {
  base64ContentSchema,
  HttpError,
  maxProjectBytes,
  MissingSourceError,
} from "./project";
import type { SourceStore } from "./types";

const sourceHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const sizeSchema = z.number().int().nonnegative();
// A submission carries changed text as JSON, which the compile route already
// holds to 10 MiB, or only names saved sources.
export const maxSourceSyncBytes = 12 * 1024 * 1024;
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const mainFileSchema = sourcePathSchema.refine((value) =>
  value.endsWith(".tex"),
);
const contentSchema = z.union([z.string(), base64ContentSchema]);
// `size` marks a source the caller read from the project's saved file table,
// so the coordinator need not look it up.
export const sourceDeltaSchema = z
  .object({
    mainFile: mainFileSchema,
    baseRevision: revisionSchema,
    revision: revisionSchema,
    files: z.record(
      sourcePathSchema,
      z.object({
        hash: sourceHashSchema,
        key: z.string().optional(),
        content: contentSchema.optional(),
        size: sizeSchema.optional(),
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

// A complete set of sources with no revision, such as a template snapshot. A
// file is inline content or the key of a saved object.
export const sourceSnapshotSchema = z.object({
  mainFile: mainFileSchema.default("main.tex"),
  files: z.record(
    sourcePathSchema,
    z.union([
      contentSchema,
      z.object({ hash: sourceHashSchema, size: sizeSchema, key: z.string() }),
    ]),
  ),
  preview: z.literal(true).optional(),
});
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

// What a build compiles. A file without a key is a draft.
export const syncedProjectSchema = z.object({
  mainFile: sourcePathSchema,
  revision: revisionSchema,
  files: z.record(
    sourcePathSchema,
    z.object({
      hash: sourceHashSchema,
      size: sizeSchema,
      key: z.string().optional(),
    }),
  ),
  preview: z.boolean().optional(),
});
export type SyncedProject = z.infer<typeof syncedProjectSchema>;
type SyncedFile = SyncedProject["files"][string];

export async function sourceHash(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
const contentBytes = (content: z.infer<typeof contentSchema>) =>
  typeof content === "string"
    ? new TextEncoder().encode(content)
    : decodeSource(content.base64);
export const savedSourceKey = (projectId: string, hash: string) =>
  `projects/${projectId}/sources/${hash}`;

export class SourceResyncError extends HttpError {
  constructor(public revision: number) {
    super(409, "Source resync required");
  }
}

// The compiler verifies each hash as it receives the source.
export async function readSource(sources: SourceStore, file: SyncedFile) {
  if (file.key) {
    const object = await sources.saved.open(file.key);
    if (object?.size === file.size) return object.body;
    await object?.body.cancel();
    throw new MissingSourceError();
  }
  const bytes = sources.drafts.read(file.hash);
  if (bytes?.byteLength !== file.size) throw new MissingSourceError();
  return bytes;
}

function checkFiles(mainFile: string, files: Map<string, SyncedFile>) {
  const paths = [...files.keys()];
  if (
    !paths.length ||
    paths.length > 200 ||
    !files.has(mainFile) ||
    paths.some((path) => paths.some((other) => other.startsWith(`${path}/`)))
  )
    throw new HttpError(400, "Invalid project sources");
  if (
    [...files.values()].reduce((size, file) => size + file.size, 0) >=
    maxProjectBytes
  )
    throw new HttpError(413, "Project exceeds 10 MiB");
}

export async function applySnapshot(
  snapshot: SourceSnapshot,
  sources: SourceStore,
): Promise<SyncedProject> {
  const files = new Map<string, SyncedFile>();
  const drafts = new Map<string, Uint8Array>();
  for (const [path, file] of Object.entries(snapshot.files)) {
    if (typeof file === "object" && "key" in file) {
      files.set(path, file);
      continue;
    }
    const bytes = contentBytes(file);
    const hash = await sourceHash(bytes);
    drafts.set(hash, bytes);
    files.set(path, { hash, size: bytes.length });
  }
  checkFiles(snapshot.mainFile, files);
  for (const [hash, bytes] of drafts) sources.drafts.write(hash, bytes);
  return {
    mainFile: snapshot.mainFile,
    revision: 0,
    files: Object.fromEntries(files),
    ...(snapshot.preview ? { preview: true } : {}),
  };
}

export async function applySourceDelta(options: {
  delta: SourceDelta;
  previous: SyncedProject | null;
  sources: SourceStore;
  projectId: string;
}): Promise<SyncedProject> {
  const { delta, previous, sources, projectId } = options;
  const revision = previous?.revision ?? 0;
  if (!delta.resync && (!previous || delta.baseRevision !== revision))
    throw new SourceResyncError(revision);
  if (delta.resync && delta.baseRevision !== revision)
    throw new SourceResyncError(revision);
  const files = new Map<string, SyncedFile>(
    Object.entries(delta.resync ? {} : (previous?.files ?? {})),
  );
  const drafts = new Map<string, Uint8Array>();
  for (const file of Object.values(delta.files)) {
    if (file.content === undefined) continue;
    const bytes = contentBytes(file.content);
    if (bytes.length >= maxProjectBytes)
      throw new HttpError(413, "Project exceeds 10 MiB");
    if ((await sourceHash(bytes)) !== file.hash)
      throw new SourceResyncError(revision);
    drafts.set(file.hash, bytes);
  }
  for (const path of delta.deleted) files.delete(path);
  const resolved = await mapLimit(
    Object.entries(delta.files),
    storageConcurrency,
    async ([path, file]): Promise<[string, SyncedFile]> => {
      const draft =
        drafts.get(file.hash)?.length ?? sources.drafts.size(file.hash);
      if (draft !== null) return [path, { hash: file.hash, size: draft }];
      const key = file.key ?? savedSourceKey(projectId, file.hash);
      const prefix = `projects/${projectId}/sources/`;
      const name = key.startsWith(prefix) ? key.slice(prefix.length) : "";
      if (
        !/^(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-)?[0-9a-f]{64}$/.test(
          name,
        ) ||
        !name.endsWith(file.hash)
      )
        throw new SourceResyncError(revision);
      const size = file.size ?? (await sources.saved.size(key));
      if (size === null) throw new SourceResyncError(revision);
      return [path, { hash: file.hash, size, key }];
    },
  );
  for (const [path, file] of resolved) files.set(path, file);
  checkFiles(delta.mainFile, files);
  for (const [hash, bytes] of drafts) sources.drafts.write(hash, bytes);
  return {
    mainFile: delta.mainFile,
    revision: delta.revision,
    files: Object.fromEntries(files),
  };
}
