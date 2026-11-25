import type { BuildSnapshot } from "@texfolia/contracts";

import { withShareToken } from "#/lib/sharing/share-token";

export type BuildFile = NonNullable<
  BuildSnapshot["artifacts"]
>["files"][number];
export function buildFileUrl(
  projectId: string,
  file: BuildFile,
  shareToken?: string,
) {
  return withShareToken(
    `/api/compile/${encodeURIComponent(projectId)}?file=${encodeURIComponent(file.path)}&version=${encodeURIComponent(file.key)}`,
    shareToken,
  );
}
