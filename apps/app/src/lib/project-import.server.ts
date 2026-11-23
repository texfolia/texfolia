import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import {
  decodeSource,
  maxSourceFileBytes,
  maxSourceProjectBytes,
} from "@texfolia/storage";
import { putSource, type SourceBucket } from "@texfolia/storage/server";
import { sql } from "drizzle-orm";
import type { z } from "zod";

import { importProjectFilesSchema } from "./project.schema";

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
  return db.transaction(async (tx) => {
    const projectId = crypto.randomUUID();
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`,
    );
    await tx
      .insert(project)
      .values({ id: projectId, ownerId, name: data.name });
    const rootId = crypto.randomUUID();
    await tx.insert(projectNode).values({
      id: rootId,
      projectId,
      name: data.name,
      kind: "folder",
      sizeBytes: 0n,
    });
    const folders = new Map<string, string>([["", rootId]]);
    for (const file of data.files) {
      const parts = file.path.split("/");
      let parentId: string = rootId;
      for (const [index, folderName] of parts.slice(0, -1).entries()) {
        const depth = index + 1;
        const path = parts.slice(0, depth).join("/").toLowerCase();
        let id = folders.get(path);
        if (!id) {
          id = crypto.randomUUID();
          await tx.insert(projectNode).values({
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
      const stored = await putSource({
        tx,
        bucket,
        projectId,
        content: file.content,
        kind: file.kind,
        previousSize: 0n,
      });
      await tx.insert(projectNode).values({
        projectId,
        parentId,
        name: file.path.substring(file.path.lastIndexOf("/") + 1),
        kind: file.kind,
        ...stored,
      });
    }
    return { id: projectId };
  });
}
