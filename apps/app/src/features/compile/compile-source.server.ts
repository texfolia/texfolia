import {
  assertProjectSourcePaths,
  projectMetadataVersion,
  projectPaths,
} from "#/features/projects";
import { readProjectMetadata } from "#/features/projects/project-metadata.server";
import { lockProject } from "#/features/sharing/project-access.server";

import { createCompileSources, type CompileProject } from "./server";

// The project aggregate as `#/features/compile` sees it.
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
