import { z } from "zod";

export const projectNameSchema = z.string().trim().min(1, {
  message: "Please enter a project name.",
});

export const createProjectSchema = z.object({
  id: z.uuid(),
  name: projectNameSchema,
});

export const nodeNameSchema = z
  .string()
  .trim()
  .min(1, "Please enter a name.")
  .max(255)
  .refine(
    (name) => !/[\\/\u0000-\u001f]/.test(name) && name !== "." && name !== "..",
    {
      message: "Enter a name without slashes or control characters.",
    },
  );

export const createNodeSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  parentId: z.uuid(),
  name: nodeNameSchema,
  kind: z.enum(["text", "folder"]),
});
