import { z } from "zod";

export const projectNameSchema = z.string().trim().min(1, {
  message: "Please enter a project name.",
});

export const createProjectSchema = z.object({
  id: z.uuid(),
  name: projectNameSchema,
});

export const projectFormattingSchema = z.object({
  indent: z.number().int().min(1).max(8),
  wrap: z.boolean(),
  width: z.number().int().min(40).max(200),
});

export const updateProjectFormattingSchema = z.object({
  projectId: z.uuid(),
  formatting: projectFormattingSchema,
});
