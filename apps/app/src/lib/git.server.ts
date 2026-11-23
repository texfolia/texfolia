import type { Db } from "@texfolia/db";
import type { GitAction } from "@texfolia/git";
import {
  gitAccount,
  gitBranch as readGitBranch,
  runGit as runGitAction,
  type GitAccessToken,
} from "@texfolia/git/server";
import type { SourceBucket } from "@texfolia/storage/server";

import { createAuth } from "./auth";
import { lockProject } from "./project-access.server";

// Binds @texfolia/git to the app's project access and Better Auth accounts.
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
