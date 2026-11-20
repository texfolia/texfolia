import { sourcePathSchema } from "@texfolia/contracts";

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
