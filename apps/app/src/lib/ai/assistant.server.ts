import {
  handleCompileGet,
  handleCompilePost,
} from "#/lib/compile/compile-route.server";
import {
  createProjectNode,
  renameProjectNode,
} from "#/lib/projects/project-node.server";
import { deleteProjectNode } from "#/lib/projects/project-source.server";
import { lockProject } from "#/lib/sharing/project-access.server";

import type { AssistantWorkspace } from "./server";

/**
 * Binds `#/lib/ai` to the app's project access, node operations,
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
    readScratchpad: (options) =>
      env.COLLABORATION.getByName(options.projectId).readScratchpad(options),
    gitAction: (options) =>
      env.COLLABORATION.getByName(options.projectId).gitAction(options),
    compile: { POST: handleCompilePost, GET: handleCompileGet },
  };
}
