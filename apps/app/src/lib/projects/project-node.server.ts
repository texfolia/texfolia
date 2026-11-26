import {
  invalidateSourceBuild,
  notifyProjectMetadataChanged,
} from "#/lib/builds/client";
import { lockProject } from "#/lib/sharing/project-access.server";

import * as projects from "./server";

// Binds `#/lib/projects` node operations to the app's access check and
// invalidates the project build and live metadata after each committed change.

type Locked<Args> = Omit<Args, "lock">;

export async function createProjectNode(
  args: Locked<Parameters<typeof projects.createProjectNode>[0]>,
) {
  const created = await projects.createProjectNode({
    ...args,
    lock: lockProject,
  });
  await Promise.all([
    invalidateSourceBuild(created.projectId),
    notifyProjectMetadataChanged(created.projectId),
  ]);
  return created;
}

export async function renameProjectNode(
  args: Locked<Parameters<typeof projects.renameProjectNode>[0]>,
) {
  await projects.renameProjectNode({ ...args, lock: lockProject });
  await Promise.all([
    invalidateSourceBuild(args.data.projectId),
    notifyProjectMetadataChanged(args.data.projectId),
  ]);
}
