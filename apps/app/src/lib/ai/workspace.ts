import type { Db } from "@texfolia/db";
import type { z } from "zod";

import type { Auth } from "#/lib/auth/auth";
import type { GitAction, GitResult } from "#/lib/git";
import type { createNodeSchema, renameNodeSchema } from "#/lib/projects";
import type { createProjectNode, LockProject } from "#/lib/projects/server";
import type { saveSourceSchema } from "#/lib/storage";
import type { SourceBucket } from "#/lib/storage/server";

export type AssistantContext = { db: Db; auth: Auth };

type CompileHandler = (options: {
  request: Request;
  params: { projectId: string };
  context: AssistantContext;
}) => Promise<Response>;

/**
 * The project operations the assistant performs on a user's behalf. Each one
 * checks that user's project access itself.
 */
export type AssistantWorkspace = {
  /** Locks the project row and checks the user's access. */
  lock: LockProject;
  bucket: Pick<SourceBucket, "get">;
  createNode(options: {
    db: Db;
    userId: string;
    data: z.infer<typeof createNodeSchema>;
  }): ReturnType<typeof createProjectNode>;
  renameNode(options: {
    db: Db;
    userId: string;
    data: z.infer<typeof renameNodeSchema>;
  }): Promise<void>;
  deleteNode(options: {
    db: Db;
    userId: string;
    projectId: string;
    nodeId: string;
  }): Promise<void>;
  /** Saves through live collaboration, so open editors see the edit. */
  saveSource(options: {
    userId: string;
    name: string;
    data: z.infer<typeof saveSourceSchema>;
  }): Promise<{ objectKey: string | null }>;
  gitAction(options: {
    projectId: string;
    user: { id: string; name: string; email: string };
    action: GitAction;
  }): Promise<GitResult>;
  /** The authenticated compile route's handlers. */
  compile: { POST: CompileHandler; GET: CompileHandler };
};
