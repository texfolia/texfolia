import type { GitAction } from "#/features/git";
import { runGit } from "#/features/git/git.server";
import { invalidateSourceBuild } from "#/features/projects/project-source.server";
import type { ProjectAccessRequest } from "#/features/projects/server";
import {
  lockProject,
  shareLinkIdOf,
} from "#/features/sharing/project-access.server";

import { CollaborationRoom } from "./room";

// The Durable Object bound as `COLLABORATION`. The room comes from
// #/features/collaboration; this class supplies the app's project access, share
// links, compiler invalidation, and Git.
export class ProjectCollaboration extends CollaborationRoom<Env> {
  protected override lockProject(request: ProjectAccessRequest) {
    return lockProject(request);
  }

  protected override isAnonymous(userId: string) {
    return shareLinkIdOf(userId) !== null;
  }

  protected override sourcesChanged(projectId: string) {
    return invalidateSourceBuild(projectId, this.env.COMPILER);
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
