import { sourcePathSchema } from "@texfolia/contracts";
import { z } from "zod";

import { spellingLanguageSchema } from "#/lib/editor/spelling/languages";
import { sourceContentSchema } from "#/lib/storage";

import { isMainFileCandidate } from "./main-file";

export const projectNameSchema = z.string().trim().min(1, {
  message: "Please enter a project name.",
});

export const createProjectSchema = z.object({
  id: z.uuid(),
  name: projectNameSchema,
});

// Bounds mirror maxProjectPageSize in projects.server.ts.
export const projectsPageSchema = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .optional();

export const projectIdSchema = z.object({ projectId: z.uuid() });

// How long a project stays in the trash before it is permanently deleted.
export const trashRetentionDays = 30;

export const renameProjectSchema = z.object({
  projectId: z.uuid(),
  name: projectNameSchema,
});
export const projectTagsSchema = z.object({
  projectId: z.uuid(),
  tags: z
    .array(
      z
        .string()
        .transform((name) => name.normalize("NFKC").trim().toLowerCase())
        .pipe(z.string().min(1).max(32)),
    )
    .max(12)
    .transform((tags) => [...new Set(tags)].sort()),
});
export const importProjectFilesSchema = z.object({
  name: projectNameSchema,
  files: z
    .array(
      z.object({
        path: sourcePathSchema,
        kind: z.enum(["text", "binary"]),
        content: sourceContentSchema,
      }),
    )
    .min(1, "Choose at least one file.")
    .max(400, "Choose at most 400 files."),
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

export const updateProjectMainFileSchema = z.object({
  projectId: z.uuid(),
  /** Null returns to the default: main.tex, else the first .tex file. */
  mainFile: sourcePathSchema
    .refine(isMainFileCandidate, "Choose a .tex file.")
    .nullable(),
});

export const updateProjectSpellingSchema = z.object({
  projectId: z.uuid(),
  language: spellingLanguageSchema,
});
