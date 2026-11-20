import { z } from "zod";

// The Go engine enforces the same policy. fixtures/path-policy.json keeps the two
// in sync.
export const maxArtifactPathBytes = 255;
export const maxSourcePathBytes = 240;
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

// Generated build files, which may use the reserved out/ folder.
export const artifactPathSchema = relativePathSchema.refine(
  (path) => pathBytes(path) <= maxArtifactPathBytes,
  "Use a path of at most 255 UTF-8 bytes.",
);

// Project sources. The source limit is below the artifact limit, so every
// source path is also a valid artifact path.
export const sourcePathSchema = relativePathSchema
  .refine((path) => pathBytes(path) <= maxSourcePathBytes, pathLengthMessage)
  .refine(
    (path) => path.split("/")[0]?.toLowerCase() !== "out",
    "out/ is reserved for generated build files. Choose another root name.",
  );

// One file or folder name in the project tree.
export const nodeNameSchema = relativePathSchema
  .refine((path) => pathBytes(path) <= maxSourcePathBytes, pathLengthMessage)
  .refine(
    (name) => !name.includes("/"),
    "Enter a file or folder name without slashes.",
  );
