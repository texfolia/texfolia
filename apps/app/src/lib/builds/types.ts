import { type EngineTiming, type planSchema } from "@texfolia/contracts";
import type { z } from "zod";

import type { SyncedProject } from "./source-sync";

// Build artifacts, results, previews and cache archives.
export interface ObjectStore {
  read(key: string): Promise<ReadableStream<Uint8Array> | null>;
  // The size is known before the body is read.
  open(
    key: string,
  ): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
  create(key: string, value: string | Uint8Array): Promise<boolean>;
  write(key: string, value: string | Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string, before?: number): AsyncIterable<string>;
}

// Where a build's sources come from. `saved` is the app's source bucket and is
// never written here. `drafts` holds submitted content that is not saved yet,
// in the coordinator's own storage.
export interface SourceStore {
  saved: {
    size(key: string): Promise<number | null>;
    read(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  };
  drafts: {
    size(hash: string): number | null;
    read(hash: string): Uint8Array<ArrayBuffer> | null;
    write(hash: string, bytes: Uint8Array): void;
    retain(hashes: ReadonlySet<string>): void;
  };
}

export type LogFile = { path: string; content: Uint8Array };

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
    onPdf?: (body: ReadableStream<Uint8Array>) => void;
    readSource: (
      file: SyncedProject["files"][string],
    ) => Promise<Uint8Array<ArrayBuffer>>;
  },
) => Promise<{
  pdf: Uint8Array;
  log: string;
  timing: EngineTiming;
  files?: Record<string, Uint8Array>;
  cacheArchive?: Uint8Array;
  preview?: Uint8Array;
}>;
