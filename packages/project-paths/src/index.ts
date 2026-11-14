import { z } from "zod";

export const maxSourcePathBytes = 240;
export const maxArtifactPathBytes = 255;
export const pathBytes = (path: string) =>
  new TextEncoder().encode(path).length;
const pathLengthMessage =
  "Use a path of at most 240 UTF-8 bytes, including folders and slashes. Shorten the name or choose a shorter parent folder.";

const relativePathSchema = z
  .string()
  .min(1, "Please enter a name.")
  .refine(
    (path) =>
      // oxlint-disable-next-line no-control-regex -- Paths must reject control characters.
      !/[\\:\u0000-\u001f]/.test(path) &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a relative path without colons, backslashes, control characters, or empty, . or .. components.",
  );

export const artifactPathSchema = relativePathSchema.refine(
  (path) => pathBytes(path) <= maxArtifactPathBytes,
  "Use an artifact path of at most 255 UTF-8 bytes.",
);

export const sourcePathSchema = relativePathSchema
  .refine((path) => pathBytes(path) <= maxSourcePathBytes, pathLengthMessage)
  .refine(
    (path) => path.split("/")[0]?.toLowerCase() !== "out",
    "out/ is reserved for generated build files. Choose another root name.",
  );

export const nodeNameSchema = relativePathSchema
  .refine((path) => pathBytes(path) <= maxSourcePathBytes, pathLengthMessage)
  .refine(
    (name) => !name.includes("/"),
    "Enter a file or folder name without slashes.",
  );

export function sourcePathError(path: string) {
  const parsed = sourcePathSchema.safeParse(path);
  return parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? "Invalid source path.");
}

export class InvalidSourcePathError extends Error {}

export function assertSourcePath(path: string) {
  const error = sourcePathError(path);
  if (error)
    throw new InvalidSourcePathError(`${JSON.stringify(path)}: ${error}`);
}
