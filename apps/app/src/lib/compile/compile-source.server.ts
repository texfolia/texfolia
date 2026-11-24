import {
  assertProjectSourcePaths,
  projectMetadataVersion,
  projectPaths,
} from "#/lib/projects";
import { readProjectMetadata } from "#/lib/projects/project-metadata.server";
import { lockProject } from "#/lib/sharing/project-access.server";

import { createCompileSources, type CompileProject } from "./server";

// The project aggregate as `#/lib/compile` sees it.
export const compileProject: CompileProject = {
  lock: lockProject,
  async metadataVersion({ tx, projectId, userId }) {
    const metadata = await readProjectMetadata({ tx, projectId, userId });
    assertProjectSourcePaths(metadata.nodes);
    return projectMetadataVersion(metadata);
  },
  sourcePaths(nodes) {
    assertProjectSourcePaths(nodes);
    return projectPaths(nodes);
  },
};

export const { withCompileSources, compileResync } =
  createCompileSources(compileProject);
