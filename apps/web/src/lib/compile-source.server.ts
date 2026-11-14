import type { Db } from "@texfolia/db";
import type { z } from "zod";

import { compileDeltaSchema, hashSource } from "./latex/source-sync";
import { lockProject } from "./project-access.server";
import { projectMetadataVersion } from "./project-metadata";
import { readProjectMetadata } from "./project-metadata.server";
import { assertProjectSourcePaths, projectPaths } from "./project-paths";
import { encodeSource } from "./project-source";
import type { SourceBucket } from "./project-source.server";

type CompileOptions = {
  db: Db;
  bucket: SourceBucket;
  projectId: string;
  userId: string;
  mainFile: string;
  sourceRevision: number;
  client?: { version: string; delta: z.infer<typeof compileDeltaSchema> };
};
type CompileSnapshot = z.infer<typeof compileDeltaSchema> & { resync: boolean };

export function compileResync(options: CompileOptions) {
  return withCompileSources({ ...options, submit: async (sources) => sources });
}

export async function withCompileSources<T>(
  options: CompileOptions & {
    submit: (sources: CompileSnapshot) => Promise<T>;
  },
) {
  const { db, bucket, projectId, userId, mainFile, sourceRevision } = options;
  return db.transaction(async (tx) => {
    await lockProject({ tx, projectId, userId });
    if (options.client) {
      const metadata = await readProjectMetadata({ tx, projectId, userId });
      assertProjectSourcePaths(metadata.nodes);
      if ((await projectMetadataVersion(metadata)) === options.client.version)
        return options.submit({ ...options.client.delta, resync: false });
    }
    const nodes = await tx.query.projectNode.findMany({
      where: { projectId, deletedAt: { isNull: true } },
    });
    assertProjectSourcePaths(nodes);
    const paths = projectPaths(nodes);
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
