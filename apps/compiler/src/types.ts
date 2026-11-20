import { type EngineTiming, type planSchema } from "@texfolia/contracts";
import type { z } from "zod";

import type { artifactFilesSchema, Project } from "./project";
import type { SourceContent, SyncedProject } from "./source-sync";

export interface ObjectStore {
  read(key: string): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<{ size: number; metadata?: string } | null>;
  create(
    key: string,
    value: string | Uint8Array,
    metadata?: string,
  ): Promise<boolean>;
  write(key: string, value: string | Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string, before?: number): AsyncIterable<string>;
}

export type Engine = ((
  project: Project | SyncedProject,
  context: {
    jobId: string;
    userId?: string;
    timeoutMs?: number;
    attempt: number;
    plan: z.infer<typeof planSchema>;
    projectId?: string;
    signal?: AbortSignal;
    cache?: z.infer<typeof artifactFilesSchema>;
    clean?: boolean;
    onPdf?: (body: ReadableStream<Uint8Array>) => void;
    readSource?: (
      file: SyncedProject["files"][string],
    ) => Promise<SourceContent>;
  },
) => Promise<{
  pdf: Uint8Array;
  log: string;
  timing: EngineTiming;
  files?: Record<string, Blob>;
  cacheArchive?: Blob;
  preview?: Uint8Array;
}>) & { prewarm?: () => Promise<void> };
