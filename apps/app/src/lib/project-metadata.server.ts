import type { Db } from "@texfolia/db";

import * as projects from "#/features/projects/server";

import { lockProject, shareLinkIdOf } from "./project-access.server";
import { commentsVersion } from "./project-comments.server";

// Adds the app's access check and the review-comments version to the
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
    return {
      ...metadata,
      // Share-link guests cannot see comments.
      commentsVersion:
        shareLinkIdOf(options.userId) === null
          ? await commentsVersion(tx, options.projectId)
          : undefined,
    };
  });
}
