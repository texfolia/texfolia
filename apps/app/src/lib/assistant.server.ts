import type { AssistantWorkspace } from "#/features/ai/server";

import { handleCompileGet, handleCompilePost } from "./compile-route.server";
import { lockProject } from "./project-access.server";
import { createProjectNode, renameProjectNode } from "./project-node.server";
import { deleteProjectNode } from "./project-source.server";

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
