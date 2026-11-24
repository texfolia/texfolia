import { type EngineTiming, type planSchema } from "@texfolia/contracts";
import type { CompileSinks } from "@texfolia/contracts/compiler";
import type { z } from "zod";

import type { SyncedProject } from "./source-sync";

// Build artifacts, results, previews and cache archives.
export interface ObjectStore {
  read(key: string): Promise<ReadableStream<Uint8Array> | null>;
  // The size is that of the whole object, and is known before the body is read.
  open(
    key: string,
    offset?: number,
  ): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
  create(key: string, value: string | Uint8Array): Promise<boolean>;
  write(key: string, value: string | Uint8Array): Promise<void>;
  // Writes exactly `size` bytes as they arrive. `saved` is false when `create`
  // is set and the object already exists.
  upload(
    key: string,
    size: number,
    options: { create: boolean },
  ): { body: WritableStream<Uint8Array>; saved: Promise<boolean> };
  remove(key: string): Promise<void>;
  keys(prefix: string, before?: number): AsyncIterable<string>;
}

// Where a build's sources come from. `saved` is the app's source bucket and is
// never written here. `drafts` holds submitted content that is not saved yet,
// in the coordinator's own storage.
export interface SourceStore {
  saved: {
    size(key: string): Promise<number | null>;
    open(
      key: string,
    ): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
  };
  drafts: {
    size(hash: string): number | null;
    read(hash: string): Uint8Array<ArrayBuffer> | null;
    write(hash: string, bytes: Uint8Array): void;
    retain(hashes: ReadonlySet<string>): void;
  };
}

export type Engine = (
  project: SyncedProject,
  context: {
    jobId: string;
    userId?: string;
    timeoutMs?: number;
    attempt: number;
    plan: z.infer<typeof planSchema>;
    projectId?: string;
    signal?: AbortSignal;
    clean?: boolean;
    readSource: (
      file: SyncedProject["files"][string],
    ) => Promise<Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>>;
    // Where the engine streams the PDF, the other files, and the cache.
    artifacts: Required<CompileSinks>;
  },
) => Promise<{
  sizeBytes: number;
  log: string;
  timing: EngineTiming;
}>;
