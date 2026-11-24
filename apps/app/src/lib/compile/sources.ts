import type { Db } from "@texfolia/db";
import type { projectNode } from "@texfolia/db/schema";
import type { z } from "zod";

import { encodeSource } from "#/lib/storage";
import type { SourceBucket } from "#/lib/storage/server";

import { compileDeltaSchema, hashSource } from "./source-sync";

// A transaction on the app database.
export type CompileTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

export type CompileShareScope = "project" | "pdf" | null;

// The project aggregate, which the app owns. Compile code locks projects and
// reads their metadata and paths only through these calls.
export type CompileProject = {
  // Locks the project for the caller and checks access. Throws
  // `Error("Project not found")` when the caller cannot use it. "build" covers
  // build files, the PDF, and the live build stream.
  lock(options: {
    tx: CompileTransaction;
    projectId: string;
    userId: string;
    access?: "read" | "write";
    content?: "sources" | "build";
  }): Promise<{ shareScope: CompileShareScope }>;
  // The metadata version the browser sends as `X-Source-Metadata`. Throws when
  // a saved path is invalid.
  metadataVersion(options: {
    tx: CompileTransaction;
    projectId: string;
    userId: string;
  }): Promise<string>;
  // Maps file node IDs to their paths, without folders. Throws when a saved
  // path is invalid.
  sourcePaths(nodes: (typeof projectNode.$inferSelect)[]): Map<string, string>;
};

export type CompileSourceOptions = {
  db: Db;
  bucket: SourceBucket;
  projectId: string;
  userId: string;
  mainFile: string;
  sourceRevision: number;
  client?: { version: string; delta: z.infer<typeof compileDeltaSchema> };
};
export type CompileSnapshot = z.infer<typeof compileDeltaSchema> & {
  resync: boolean;
};

export function createCompileSources(project: CompileProject) {
  // Runs `submit` with the browser's delta when its metadata is current, or
  // with every saved source otherwise, while the project stays locked.
  function withCompileSources<T>(
    options: CompileSourceOptions & {
      submit: (sources: CompileSnapshot) => Promise<T>;
    },
  ) {
    const { db, bucket, projectId, userId, mainFile, sourceRevision } = options;
    return db.transaction(async (tx) => {
      await project.lock({ tx, projectId, userId });
      if (
        options.client &&
        (await project.metadataVersion({ tx, projectId, userId })) ===
          options.client.version
      )
        return options.submit({ ...options.client.delta, resync: false });
      const nodes = await tx.query.projectNode.findMany({
        where: { projectId, deletedAt: { isNull: true } },
      });
      const paths = project.sourcePaths(nodes);
      if (
        !paths.size ||
        paths.size > 200 ||
        ![...paths.values()].includes(mainFile)
      )
        throw new Error("Provide 1–200 files including mainFile");
      if (
        nodes.reduce((size, node) => size + node.sizeBytes, 0n) >=
        10n * 1024n * 1024n
      )
        throw new Error("Project exceeds the compiler's 10 MiB source limit");
      const files: z.infer<typeof compileDeltaSchema>["files"] = {};
      for (const node of nodes) {
        const path = paths.get(node.id);
        if (!path) continue;
        const object = node.objectKey ? await bucket.get(node.objectKey) : null;
        if (node.objectKey && !object)
          throw new Error("Saved source is missing from storage");
        const bytes = object
          ? new Uint8Array(await object.arrayBuffer())
          : new Uint8Array();
        const hash = await hashSource(bytes);
        if (
          node.objectKey &&
          node.objectKey !== `projects/${projectId}/sources/${hash}`
        )
          throw new Error("Saved source hash mismatch");
        Object.defineProperty(files, path, {
          enumerable: true,
          value: {
            hash,
            content:
              node.kind === "text"
                ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
                : { base64: encodeSource(bytes) },
          },
        });
      }
      return options.submit({
        mainFile,
        baseRevision: sourceRevision,
        revision: sourceRevision + 1,
        files,
        deleted: [],
        resync: true,
      });
    });
  }

  // Every saved source, as the compiler receives it after a resync.
  function compileResync(options: CompileSourceOptions) {
    return withCompileSources({
      ...options,
      submit: async (sources) => sources,
    });
  }

  return { withCompileSources, compileResync };
}
