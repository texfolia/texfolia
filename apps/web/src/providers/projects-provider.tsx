import { createContext, type ReactNode, useContext } from "react";

import {
  createProject,
  deleteProject,
  getProjects,
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
    ownerId,
    projects,
    async refresh() {
      projects.utils.replace(await getProjects());
    },
    async create(name: string) {
      const id = crypto.randomUUID();
      const now = new Date();
      await projects
        .insert({
          id,
          name: projectNameSchema.parse(name),
          ownerId,
          organizationId: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          formatIndent: 2,
          formatWrap: true,
          formatWidth: 80,
          collaborators: [],
          owner: null,
          people: [],
          tags: [],
          canWrite: true,
          canDelete: true,
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
