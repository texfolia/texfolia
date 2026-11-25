import { buildsFetcher, invalidateSourceBuild } from "#/lib/builds/client";
import type { GitAction } from "#/lib/git";
import { runGit } from "#/lib/git/git.server";
import type { ProjectAccessRequest } from "#/lib/projects/server";
import {
  lockProject,
  lockProjectReaders,
  shareLinkIdOf,
} from "#/lib/sharing/project-access.server";

import { CollaborationRoom } from "./room";

// The Durable Object bound as `COLLABORATION`. The room comes from
// #/lib/collaboration; this class supplies the app's project access, share
// links, build invalidation, and Git.
export class ProjectCollaboration extends CollaborationRoom<Env> {
  protected override lockProject(request: ProjectAccessRequest) {
    return lockProject(request);
  }

  protected override lockReaders(
    request: Parameters<typeof lockProjectReaders>[0],
  ) {
    return lockProjectReaders(request);
  }

  protected override isAnonymous(userId: string) {
    return shareLinkIdOf(userId) !== null;
  }

  protected override sourcesChanged(projectId: string) {
    return invalidateSourceBuild(projectId, buildsFetcher(this.env.BUILDS));
  }

  async gitAction(options: {
    projectId: string;
    user: { id: string; name: string; email: string };
    action: GitAction;
  }) {
    return this.withSavedSources({
      projectId: options.projectId,
      userId: options.user.id,
      access:
        options.action.kind === "status" || options.action.kind === "diff"
          ? "read"
          : "write",
      run: (db, exclusively) =>
        runGit({ db, bucket: this.env.SOURCES, exclusively, ...options }),
    });
  }
}
