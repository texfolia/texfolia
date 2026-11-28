import type { BuildSnapshot } from "@texfolia/contracts";

export type BuildFile = NonNullable<
  BuildSnapshot["artifacts"]
>["files"][number];
export function buildFileUrl(projectId: string, file: BuildFile) {
  return `/api/compile/${encodeURIComponent(projectId)}?file=${encodeURIComponent(file.path)}&version=${encodeURIComponent(file.key)}`;
}
