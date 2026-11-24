import {
  cleanupDeletedCollaboration,
  invalidateCollaborationAccess,
  type CollaborationAccess,
  type CollaborationCleanup,
} from "#/lib/collaboration/server";
import { fetchCompiler } from "#/lib/compile/server";
import { lockProject } from "#/lib/sharing/project-access.server";

import * as projects from "./server";

// Binds `#/lib/projects` operations to the app's composed access check and
// adds post-commit cleanup the feature does not own.

type Locked<Args> = Omit<Args, "lock">;

export {
  accessibleProjects,
  createProject,
  getProjects,
  getTrashedProjects,
  maxProjectPageSize,
  projectPageSize,
  restoreProject,
} from "./server";

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

export function duplicateProject(
  args: Locked<Parameters<typeof projects.duplicateProject>[0]>,
) {
  return projects.duplicateProject({ ...args, lock: lockProject });
}

export async function trashProject({
  collaboration,
  ...args
}: Locked<Parameters<typeof projects.trashProject>[0]> & {
  collaboration?: CollaborationAccess;
}) {
  const { projectId } = args;
  await projects.trashProject({ ...args, lock: lockProject });
  await invalidateCollaborationAccess(collaboration, projectId);
  try {
    const response = await fetchCompiler(`/projects/${projectId}/build`, {
      method: "DELETE",
    });
    if (!response.ok)
      throw new Error(`Build cleanup returned ${response.status}`);
  } catch (error) {
    // The coordinator's retention alarm also removes artifacts if immediate cleanup is unavailable.
    console.error("Trashed project build cleanup failed", { projectId, error });
  }
}

export async function deleteTrashedProject({
  collaboration,
  ...args
}: Parameters<typeof projects.deleteTrashedProject>[0] & {
  collaboration?: CollaborationCleanup;
}) {
  await projects.deleteTrashedProject(args);
  await cleanupDeletedCollaboration(collaboration, args.projectId);
}

export async function deleteExpiredProjects({
  collaboration,
  ...args
}: Parameters<typeof projects.deleteExpiredProjects>[0] & {
  collaboration?: CollaborationCleanup;
}) {
  const projectIds = await projects.deleteExpiredProjects(args);
  for (const projectId of projectIds)
    await cleanupDeletedCollaboration(collaboration, projectId);
}
