import { nodeNameSchema } from "@texfolia/project-paths";
import { z } from "zod";

import { sourceContentSchema } from "./project-source";

export { nodeNameSchema };

export const createNodeSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    parentId: z.uuid(),
    name: nodeNameSchema,
    kind: z.enum(["text", "folder", "binary"]),
    content: sourceContentSchema.optional(),
  })
  .refine(
    (node) => node.kind !== "binary" || node.content !== undefined,
    "Binary files require content",
  )
  .refine(
    (node) => node.kind !== "folder" || node.content === undefined,
    "Folders cannot have content",
  );

export const renameNodeSchema = z.object({
  projectId: z.uuid(),
  nodeId: z.uuid(),
  parentId: z.uuid(),
  name: nodeNameSchema,
});
