import * as projects from "@texfolia/projects/server";

import { lockProject } from "./project-access.server";
import { invalidateSourceBuild } from "./project-source.server";

// Binds `@texfolia/projects` node operations to the app's access check and
// invalidates the project build after each committed change.

type Locked<Args> = Omit<Args, "lock">;

export async function createProjectNode(
  args: Locked<Parameters<typeof projects.createProjectNode>[0]>,
) {
  const created = await projects.createProjectNode({
    ...args,
    lock: lockProject,
  });
  await invalidateSourceBuild(created.projectId);
  return created;
}

export async function renameProjectNode(
  args: Locked<Parameters<typeof projects.renameProjectNode>[0]>,
) {
  await projects.renameProjectNode({ ...args, lock: lockProject });
  await invalidateSourceBuild(args.data.projectId);
}
