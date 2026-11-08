import { z } from "zod";

import { createRpcCollection } from "#/data/rpc-collection";

import { createNodeSchema, projectNameSchema } from "./schema";
import {
  createProject,
  createProjectNode,
  deleteProject,
  type getProject,
  type GetProjectsResult,
} from "./server";

export type Project = GetProjectsResult[number];
export type ProjectDetails = Awaited<ReturnType<typeof getProject>>;
export type ProjectNode = ProjectDetails["nodes"][number];

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

type NewNode = z.input<typeof createNodeSchema>;

export function createProjectFilesStore({
  initial,
  projectId,
}: {
  initial: ProjectNode[];
  projectId: string;
}) {
  const nodes = createRpcCollection({
    initial,
    insert: (row) => createProjectNode({ data: createNodeSchema.parse(row) }),
  });

  return {
    nodes,
    async create(input: Pick<NewNode, "parentId" | "name" | "kind">) {
      const row = createNodeSchema.parse({
        ...input,
        id: crypto.randomUUID(),
        projectId,
      });
      await nodes.insert(row).when("settled");
      return row;
    },
  };
}
