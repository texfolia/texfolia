import { z } from "zod";

export const projectAccessSchema = z.object({ projectId: z.uuid() });
export const grantProjectAccessSchema = projectAccessSchema.extend({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(["viewer", "editor"]),
});
export const revokeProjectAccessSchema = projectAccessSchema.extend({
  userId: z.string().min(1),
});
export const transferProjectSchema = projectAccessSchema.extend({
  userId: z.string().min(1),
});
