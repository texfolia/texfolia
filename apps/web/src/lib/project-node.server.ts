import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";

import { fetchCompiler } from "./compiler.server";
import type { createNodeSchema } from "./project-node.schema";

export async function createProjectNode({
  db,
  ownerId,
  data,
}: {
  db: Db;
  ownerId: string;
  data: z.infer<typeof createNodeSchema>;
}) {
  const created = await db.transaction(async (tx) => {
    // Serialize structure changes with deletion and verify ownership before
    // accepting a parent supplied by the client.
    const [ownedProject] = await tx
      .select({ id: project.id })
      .from(project)
      .where(
        and(
          eq(project.id, data.projectId),
          eq(project.ownerId, ownerId),
          isNull(project.deletedAt),
        ),
      )
      .for("update");
    if (!ownedProject) throw new Error("Project not found");
    const parent = await tx.query.projectNode.findFirst({
      where: {
        id: data.parentId,
        projectId: data.projectId,
        kind: "folder",
        deletedAt: { isNull: true },
      },
    });
    if (!parent) throw new Error("Folder not found");
    if (parent.parentId === null && data.name.toLowerCase() === "out")
      throw new Error("out/ is reserved for generated build files");
    const [node] = await tx
      .insert(projectNode)
      .values({ ...data, sizeBytes: 0n })
      .returning({
        id: projectNode.id,
        projectId: projectNode.projectId,
        parentId: projectNode.parentId,
        name: projectNode.name,
        kind: projectNode.kind,
      });
    if (!node) throw new Error("Failed to create file");
    await tx
      .update(project)
      .set({ updatedAt: new Date() })
      .where(eq(project.id, data.projectId));
    return node;
  });
  try {
    const response = await fetchCompiler(
      `/projects/${data.projectId}/changed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editorId: crypto.randomUUID(), sequence: 0 }),
      },
    );
    if (!response.ok)
      throw new Error(`Build invalidation returned ${response.status}`);
  } catch (error) {
    console.error("Source created but build invalidation failed", {
      projectId: data.projectId,
      error,
    });
  }
  return created;
}
