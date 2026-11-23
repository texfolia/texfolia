import {
  handleCompileGet,
  handleCompilePost,
} from "#/features/compile/compile-route.server";
import {
  createProjectNode,
  renameProjectNode,
} from "#/features/projects/project-node.server";
import { deleteProjectNode } from "#/features/projects/project-source.server";
import { lockProject } from "#/features/sharing/project-access.server";

import type { AssistantWorkspace } from "./server";

/**
 * Binds `#/features/ai` to the app's project access, node operations,
 * collaboration room, and compile route.
 */
export function assistantWorkspace(env: Env): AssistantWorkspace {
  return {
    lock: lockProject,
    bucket: env.SOURCES,
    createNode: ({ userId, ...options }) =>
      createProjectNode({ ...options, ownerId: userId, bucket: env.SOURCES }),
    renameNode: renameProjectNode,
    deleteNode: (options) =>
      deleteProjectNode({ ...options, collaboration: env.COLLABORATION }),
    saveSource: (options) =>
      env.COLLABORATION.getByName(options.data.projectId).saveSource(options),
    gitAction: (options) =>
      env.COLLABORATION.getByName(options.projectId).gitAction(options),
    compile: { POST: handleCompilePost, GET: handleCompileGet },
  };
}
