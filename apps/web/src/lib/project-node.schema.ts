import { z } from "zod";

import { sourceContentSchema } from "./project-source";

export const nodeNameSchema = z
  .string()
  .trim()
  .min(1, "Please enter a name.")
  .max(255)
  .refine(
    // oxlint-disable-next-line no-control-regex -- File names must reject control characters.
    (name) => !/[\\/\u0000-\u001f]/.test(name) && name !== "." && name !== "..",
    {
      message: "Enter a name without slashes or control characters.",
    },
  );

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
