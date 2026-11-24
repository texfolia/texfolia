import { buildsFetcher } from "#/lib/builds/client";
import type { GitAction } from "#/lib/git";
import { runGit } from "#/lib/git/git.server";
import { invalidateSourceBuild } from "#/lib/projects/project-source.server";
import type { ProjectAccessRequest } from "#/lib/projects/server";
import {
  lockProject,
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
      rewritesSources: ["import", "pull", "checkout"].includes(
        options.action.kind,
      ),
      run: (db) => runGit({ db, bucket: this.env.SOURCES, ...options }),
    });
  }
}
