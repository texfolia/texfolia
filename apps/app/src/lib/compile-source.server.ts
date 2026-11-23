import {
  createCompileSources,
  type CompileProject,
} from "@texfolia/compile/server";
import {
  assertProjectSourcePaths,
  projectMetadataVersion,
  projectPaths,
} from "@texfolia/projects";

import { lockProject } from "./project-access.server";
import { readProjectMetadata } from "./project-metadata.server";

// The project aggregate as `@texfolia/compile` sees it.
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
