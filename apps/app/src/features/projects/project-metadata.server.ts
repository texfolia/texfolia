import type { Db } from "@texfolia/db";

import { commentsVersion } from "#/features/comments/project-comments.server";
import { gitVersion } from "#/features/git/server";
import {
  lockProject,
  shareLinkIdOf,
} from "#/features/sharing/project-access.server";

import * as projects from "./server";

// Adds the app's access check, review-comments version, and Git version to the
// metadata `#/features/projects` reads.

export function readProjectMetadata(
  args: Omit<Parameters<typeof projects.readProjectMetadata>[0], "lock">,
) {
  return projects.readProjectMetadata({ ...args, lock: lockProject });
}

export function getProjectMetadata({
  db,
  ...options
}: {
  db: Db;
  projectId: string;
  userId: string;
}) {
  return db.transaction(async (tx) => {
    const metadata = await readProjectMetadata({ tx, ...options });
    const signedIn = shareLinkIdOf(options.userId) === null;
    return {
      ...metadata,
      // Share-link guests cannot see comments or Git.
      commentsVersion: signedIn
        ? await commentsVersion(tx, options.projectId)
        : undefined,
      gitVersion: signedIn
        ? await gitVersion(tx, options.projectId)
        : undefined,
    };
  });
}
