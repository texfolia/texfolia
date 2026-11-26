import { sourcePathSchema } from "@texfolia/contracts";
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
export const templateVisibilities = ["public", "unlisted", "private"] as const;
export type TemplateVisibility = (typeof templateVisibilities)[number];
const publicationSchema = z.object({
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
});
/**
 * Public and unlisted snapshots can be redistributed, so they need an open
 * license and the publisher's confirmation. Private ones stay with their owner
 * or organization and need neither.
 */
export const publishTemplateSchema = z.discriminatedUnion("visibility", [
  publicationSchema.extend({
    visibility: z.enum(["public", "unlisted"]),
    license: z.enum(templateLicenses),
    redistributionConfirmed: z.literal(true),
  }),
  publicationSchema.extend({ visibility: z.literal("private") }),
]);
/** The most private templates an owner or organization may keep, by plan. */
export const privateTemplateLimits = { free: 0, pro: 1000, team: 1000 };
// Postgres text cannot hold a NUL.
const filterSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\0"));
/** Tags as they are stored, so that filters match them. */
const tagSchema = filterSchema.toLowerCase().max(32);
const searchSchema = filterSchema.max(100);
export const listTemplatesSchema = z.object({
  page: z.number().int().min(0).max(1000).default(0),
  q: searchSchema.optional(),
  tag: tagSchema.optional(),
  license: z.enum(templateLicenses).optional(),
});
/** The catalog request of a URL. Values it cannot use do not filter. */
export const templateQuerySchema = z.object({
  page: z.coerce.number().int().min(0).max(1000).catch(0),
  q: searchSchema.optional().catch(undefined),
  tag: tagSchema.optional().catch(undefined),
  license: z.enum(templateLicenses).optional().catch(undefined),
});
export const refreshTemplatePreviewSchema = templateIdSchema.extend({
  retry: z.boolean().default(false),
});
export const openTemplateSchema = templateIdSchema.extend({
  organizationId: z.string().min(1).max(128).nullable(),
  name: z.string().trim().min(1).optional(),
});
export const reportTemplateSchema = templateIdSchema.extend({
  reason: z.string().trim().min(10).max(2000),
});
export const maxRejectionReason = 2000;
export const reviewTemplateSchema = z.discriminatedUnion("decision", [
  templateIdSchema.extend({ decision: z.literal("approved") }),
  templateIdSchema.extend({
    decision: z.literal("rejected"),
    reason: z.string().trim().min(10).max(maxRejectionReason),
  }),
]);
export const setTemplatePublishedSchema = templateIdSchema.extend({
  published: z.boolean(),
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
