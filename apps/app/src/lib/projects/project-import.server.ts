import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import type { z } from "zod";

import { importProjectFilesSchema } from "#/lib/projects";
import {
  decodeSource,
  maxSourceFileBytes,
  maxSourceProjectBytes,
} from "#/lib/storage";
import {
  commitSources,
  prepareSource,
  type SourceBucket,
} from "#/lib/storage/server";

export async function importProjectFiles({
  db,
  bucket,
  ownerId,
  data,
}: {
  db: Db;
  bucket: SourceBucket;
  ownerId: string;
  data: z.infer<typeof importProjectFilesSchema>;
}) {
  data = importProjectFilesSchema.parse(data);
  const paths = new Map<string, "folder" | "text" | "binary">();
  let total = 0;
  for (const file of data.files) {
    const bytes = decodeSource(file.content);
    if (bytes.byteLength > maxSourceFileBytes)
      throw new Error("File exceeds 10 MiB");
    total += bytes.byteLength;
    if (total > maxSourceProjectBytes)
      throw new Error("Project exceeds 50 MiB");
    if (file.kind === "text")
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parts = file.path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const path = parts.slice(0, depth).join("/").toLowerCase();
      if (paths.has(path) && paths.get(path) !== "folder")
        throw new Error(`File and folder conflict: ${file.path}`);
      paths.set(path, "folder");
    }
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new Error(`Duplicate path: ${file.path}`);
    paths.set(key, file.kind);
  }
  const projectId = crypto.randomUUID();
  const rootId = crypto.randomUUID();
  const nodes: (typeof projectNode.$inferInsert)[] = [
    {
      id: rootId,
      projectId,
      name: data.name,
      kind: "folder",
      sizeBytes: 0n,
    },
  ];
  const folders = new Map<string, string>([["", rootId]]);
  const uploads = [];
  for (const file of data.files) {
    const parts = file.path.split("/");
    let parentId: string = rootId;
    for (const [index, folderName] of parts.slice(0, -1).entries()) {
      const path = parts
        .slice(0, index + 1)
        .join("/")
        .toLowerCase();
      let id = folders.get(path);
      if (!id) {
        id = crypto.randomUUID();
        nodes.push({
          id,
          projectId,
          parentId,
          name: folderName,
          kind: "folder",
          sizeBytes: 0n,
        });
        folders.set(path, id);
      }
      parentId = id;
    }
    const upload = await prepareSource(projectId, file);
    uploads.push(upload);
    nodes.push({
      projectId,
      parentId,
      name: file.path.substring(file.path.lastIndexOf("/") + 1),
      kind: file.kind,
      objectKey: upload.objectKey,
      sizeBytes: upload.sizeBytes,
    });
  }
  return commitSources({
    db,
    bucket,
    projectId,
    uploads,
    run: async (tx) => {
      await tx
        .insert(project)
        .values({ id: projectId, ownerId, name: data.name });
      await tx.insert(projectNode).values(nodes);
      return { id: projectId };
    },
  });
}
