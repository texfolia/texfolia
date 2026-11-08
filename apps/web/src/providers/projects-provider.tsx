import { createContext, type ReactNode, useContext } from "react";

import {
  createProject,
  deleteProject,
  type Project,
} from "#/lib/project.functions";
import { projectNameSchema } from "#/lib/project.schema";
import { createRpcCollection } from "#/lib/rpc-collection";

export function createProjectsStore({
  initial,
  ownerId,
}: {
  initial: Project[];
  ownerId: string;
}) {
  const projects = createRpcCollection({
    initial,
    insert: (row) => createProject({ data: { id: row.id, name: row.name } }),
    remove: (row) => deleteProject({ data: { projectId: row.id } }),
  });

  return {
    projects,
    async create(name: string) {
      const id = crypto.randomUUID();
      const now = new Date();
      await projects
        .insert({
          id,
          name: projectNameSchema.parse(name),
          ownerId,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          collaborators: [],
        })
        .when("settled");
      return id;
    },
    async remove(id: string) {
      await projects.delete(id).when("settled");
    },
  };
}

const ProjectsContext = createContext<ReturnType<
  typeof createProjectsStore
> | null>(null);

export function ProjectsProvider({
  store,
  children,
}: {
  store: ReturnType<typeof createProjectsStore>;
  children: ReactNode;
}) {
  return <ProjectsContext value={store}>{children}</ProjectsContext>;
}

export function useProjects() {
  const store = useContext(ProjectsContext);
  if (!store) throw new Error("Missing projects provider");
  return store;
}
