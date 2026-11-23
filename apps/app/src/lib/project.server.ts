import {
  cleanupDeletedCollaboration,
  type CollaborationCleanup,
} from "#/features/collaboration/server";
import { fetchCompiler } from "#/features/compile/server";
import * as projects from "#/features/projects/server";

import { lockProject } from "./project-access.server";

// Binds `#/features/projects` operations to the app's composed access check and
// adds post-commit cleanup the feature does not own.

type Locked<Args> = Omit<Args, "lock">;

export {
  accessibleProjects,
  createProject,
  getProjects,
  maxProjectPageSize,
  projectPageSize,
} from "#/features/projects/server";

export function updateProjectFormatting(
  args: Locked<Parameters<typeof projects.updateProjectFormatting>[0]>,
) {
  return projects.updateProjectFormatting({ ...args, lock: lockProject });
}

export function updateProjectSpelling(
  args: Locked<Parameters<typeof projects.updateProjectSpelling>[0]>,
) {
  return projects.updateProjectSpelling({ ...args, lock: lockProject });
}

export function renameProject(
  args: Locked<Parameters<typeof projects.renameProject>[0]>,
) {
  return projects.renameProject({ ...args, lock: lockProject });
}

export function setProjectTags(
  args: Locked<Parameters<typeof projects.setProjectTags>[0]>,
) {
  return projects.setProjectTags({ ...args, lock: lockProject });
}

export function getProject(
  args: Locked<Parameters<typeof projects.getProject>[0]>,
) {
  return projects.getProject({ ...args, lock: lockProject });
}

export async function deleteProject({
  collaboration,
  ...args
}: Locked<Parameters<typeof projects.deleteProject>[0]> & {
  collaboration?: CollaborationCleanup;
}) {
  const projectId = await projects.deleteProject({
    ...args,
    lock: lockProject,
  });
  await cleanupDeletedCollaboration(collaboration, projectId);
  try {
    const response = await fetchCompiler(`/projects/${projectId}/build`, {
      method: "DELETE",
    });
    if (!response.ok)
      throw new Error(`Build cleanup returned ${response.status}`);
  } catch (error) {
    // The coordinator's retention alarm also removes artifacts if immediate cleanup is unavailable.
    console.error("Deleted project build cleanup failed", { projectId, error });
  }
  return projectId;
}
