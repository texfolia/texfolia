import type { Db } from "@texfolia/db";

import type { GitAction } from "#/features/git";
import {
  gitAccount,
  gitBranch as readGitBranch,
  runGit as runGitAction,
  type GitAccessToken,
} from "#/features/git/server";
import type { SourceBucket } from "#/features/storage/server";

import { createAuth } from "./auth";
import { lockProject } from "./project-access.server";

// Binds #/features/git to the app's project access and Better Auth accounts.
const accessToken: GitAccessToken = async ({ db, userId, provider }) => {
  const linked = await gitAccount({ db, userId, provider });
  const token = await createAuth(db).api.getAccessToken({
    body: { accountId: linked.id, userId },
  });
  return token.accessToken;
};

export function runGit(options: {
  db: Db;
  bucket: SourceBucket;
  projectId: string;
  user: { id: string; name: string; email: string };
  action: GitAction;
}) {
  return runGitAction({ ...options, lock: lockProject, accessToken });
}

export function gitBranch(options: {
  db: Db;
  projectId: string;
  userId: string;
}) {
  return readGitBranch({ ...options, lock: lockProject });
}
