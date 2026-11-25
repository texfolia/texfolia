import type { Db } from "@texfolia/db";
import type { projectNode } from "@texfolia/db/schema";
import type { z } from "zod";

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
  projectId: string;
  userId: string;
  mainFile: string;
  sourceRevision: number;
  client?: { version: string; delta: z.infer<typeof compileDeltaSchema> };
};
// A server-side resync names each saved source by its content hash. The
// coordinator reads the bytes from the same bucket when it compiles them.
export type CompileSnapshot = Omit<
  z.infer<typeof compileDeltaSchema>,
  "files"
> & {
  files: Record<
    string,
    z.infer<typeof compileDeltaSchema>["files"][string] & { size?: number }
  >;
  resync: boolean;
};

export function createCompileSources(project: CompileProject) {
  // The browser's delta when its metadata is current, or every saved source
  // otherwise, with the metadata version they belong to. The project is unlocked
  // again when this resolves, so callers that submit them check the version after.
  async function compileSources(
    options: CompileSourceOptions,
  ): Promise<{ sources: CompileSnapshot; version: string }> {
    const { db, projectId, userId, mainFile, sourceRevision, client } = options;
    const { version, nodes } = await db.transaction(async (tx) => {
      await project.lock({ tx, projectId, userId });
      const version = await project.metadataVersion({ tx, projectId, userId });
      return {
        version,
        nodes:
          version === client?.version
            ? null
            : await tx.query.projectNode.findMany({
                where: { projectId, deletedAt: { isNull: true } },
              }),
      };
    });
    if (client && !nodes)
      return { version, sources: { ...client.delta, resync: false } };
    const saved = nodes ?? [];
    const paths = project.sourcePaths(saved);
    if (
      !paths.size ||
      paths.size > 200 ||
      ![...paths.values()].includes(mainFile)
    )
      throw new Error("Provide 1–200 files including mainFile");
    if (
      saved.reduce((size, node) => size + node.sizeBytes, 0n) >=
      10n * 1024n * 1024n
    )
      throw new Error("Project exceeds the compiler's 10 MiB source limit");
    const files: CompileSnapshot["files"] = {};
    for (const node of saved) {
      const path = paths.get(node.id);
      if (!path) continue;
      // Saved objects are content addressed, so no bytes are read here.
      const prefix = `projects/${projectId}/sources/`;
      const hash = node.objectKey?.startsWith(prefix)
        ? node.objectKey.slice(prefix.length)
        : null;
      if (node.objectKey && (!hash || !/^[0-9a-f]{64}$/.test(hash)))
        throw new Error("Saved source hash mismatch");
      Object.defineProperty(files, path, {
        enumerable: true,
        value: hash
          ? { hash, size: Number(node.sizeBytes) }
          : { hash: await hashSource(new Uint8Array()), content: "" },
      });
    }
    return {
      version,
      sources: {
        mainFile,
        baseRevision: sourceRevision,
        revision: sourceRevision + 1,
        files,
        deleted: [],
        resync: true,
      },
    };
  }

  // Whether the project still has the metadata a build was submitted with.
  function sourcesCurrent({
    db,
    version,
    ...request
  }: Pick<CompileSourceOptions, "db" | "projectId" | "userId"> & {
    version: string;
  }) {
    return db.transaction(
      async (tx) =>
        (await project.metadataVersion({ tx, ...request })) === version,
    );
  }

  // Every saved source, as the compiler receives it after a resync.
  async function compileResync(options: CompileSourceOptions) {
    return (await compileSources(options)).sources;
  }

  return { compileSources, sourcesCurrent, compileResync };
}
