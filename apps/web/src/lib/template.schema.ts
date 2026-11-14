import { sourcePathSchema } from "@texfolia/project-paths";
import { z } from "zod";

export const templateLicenses = [
  "CC0-1.0",
  "CC-BY-4.0",
  "MIT",
  "LPPL-1.3c",
] as const;
export const templateLicenseLabels = {
  "CC0-1.0": "CC0 1.0 — Public domain dedication",
  "CC-BY-4.0": "Creative Commons Attribution 4.0",
  MIT: "MIT License",
  "LPPL-1.3c": "LaTeX Project Public License 1.3c",
};
export const templateLicenseUrls = {
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  MIT: "https://opensource.org/license/mit",
  "LPPL-1.3c": "https://www.latex-project.org/lppl/lppl-1-3c/",
};

export const templateIdSchema = z.object({ templateId: z.uuid() });
export const publishTemplateSchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(4000),
  mainFile: sourcePathSchema
    .refine((path) => path.endsWith(".tex"), "Select a .tex main file.")
    .default("main.tex"),
  tags: z
    .array(z.string().trim().min(1).max(32))
    .max(8)
    .transform((tags) => [...new Set(tags.map((tag) => tag.toLowerCase()))]),
  license: z.enum(templateLicenses),
  visibility: z.enum(["public", "unlisted"]),
  redistributionConfirmed: z.literal(true),
});
export const openTemplateSchema = templateIdSchema.extend({
  organizationId: z.string().min(1).max(128).nullable(),
});
export const reportTemplateSchema = templateIdSchema.extend({
  reason: z.string().trim().min(10).max(2000),
});
export const reviewTemplateSchema = templateIdSchema.extend({
  decision: z.enum(["approved", "rejected"]),
});
export const templateSnapshotSchema = z
  .array(
    z.object({
      id: z.uuid(),
      parentId: z.uuid().nullable(),
      name: z.string().min(1).max(255),
      kind: z.enum(["folder", "text", "binary"]),
      objectKey: z.string().nullable(),
      sizeBytes: z
        .number()
        .int()
        .nonnegative()
        .max(10 * 1024 * 1024),
    }),
  )
  .min(2)
  .max(401);
