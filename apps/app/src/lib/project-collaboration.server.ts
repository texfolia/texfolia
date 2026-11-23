import { CollaborationRoom } from "@texfolia/collaboration/room";
import type { ProjectAccessRequest } from "@texfolia/projects/server";

import type { GitAction } from "./git";
import { runGit } from "./git.server";
import { lockProject, shareLinkIdOf } from "./project-access.server";
import { invalidateSourceBuild } from "./project-source.server";

// The Durable Object bound as `COLLABORATION`. The room comes from
// @texfolia/collaboration; this class supplies the app's project access, share
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
