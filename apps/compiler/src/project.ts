import { artifactPathSchema, sourcePathSchema } from "@texfolia/project-paths";
import { z } from "zod";

import { type EngineTiming, unknownEngineTiming } from "./telemetry";

export const maxProjectBytes = 10 * 1024 * 1024;
export const jobIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public log = "",
    public timing: EngineTiming = unknownEngineTiming,
    public logFile?: { path: string; base64: string },
    public retryAfter?: number,
  ) {
    super(message);
  }
}

export class EngineError extends Error {
  constructor(
    cause: unknown,
    public timing: EngineTiming,
  ) {
    super(cause instanceof Error ? cause.message : "TeX host request failed", {
      cause,
    });
  }
}

export { artifactPathSchema, sourcePathSchema };
export const artifactContentSchema = z.object({
  base64: z
    .string()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((value) => value.length % 4 === 0, "Invalid base64 content"),
});
export const artifactFilesSchema = z.record(
  artifactPathSchema,
  artifactContentSchema,
);

const projectSchema = z
  .object({
    mainFile: sourcePathSchema
      .refine((value) => value.endsWith(".tex"))
      .default("main.tex"),
    files: z.record(
      sourcePathSchema,
      z.union([z.string(), artifactContentSchema]),
    ),
    preview: z.literal(true).optional(),
  })
  .superRefine(({ mainFile, files }, ctx) => {
    const paths = Object.keys(files);
    if (!paths.length || paths.length > 200 || !Object.hasOwn(files, mainFile))
      ctx.addIssue({
        code: "custom",
        message: "Provide 1–200 files including mainFile",
      });
    if (
      paths.some((path) => paths.some((other) => other.startsWith(`${path}/`)))
    )
      ctx.addIssue({ code: "custom", message: "File paths overlap" });
  });

export type Project = z.infer<typeof projectSchema>;

export function parseProject(value: unknown): Project {
  const parsed = projectSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Invalid project sources");
  return parsed.data;
}
