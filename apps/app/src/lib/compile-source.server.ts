import {
  createCompileSources,
  type CompileProject,
} from "@texfolia/compile/server";

import { lockProject } from "./project-access.server";
import { projectMetadataVersion } from "./project-metadata";
import { readProjectMetadata } from "./project-metadata.server";
import { assertProjectSourcePaths, projectPaths } from "./project-paths";

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
