import { z } from "zod";

export const projectNameSchema = z.string().trim().min(1, {
  message: "Please enter a project name.",
});

export const createProjectSchema = z.object({
  id: z.uuid(),
  name: projectNameSchema,
});
