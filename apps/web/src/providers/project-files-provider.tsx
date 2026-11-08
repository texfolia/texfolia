import { createContext, type ReactNode, useContext } from "react";
import type { z } from "zod";

import { createProjectNode } from "#/lib/project-node.functions";
import { createNodeSchema } from "#/lib/project-node.schema";
import type { ProjectNode } from "#/lib/project.functions";
import { createRpcCollection } from "#/lib/rpc-collection";

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

const ProjectFilesContext = createContext<ReturnType<
  typeof createProjectFilesStore
> | null>(null);

export function ProjectFilesProvider({
  store,
  children,
}: {
  store: ReturnType<typeof createProjectFilesStore>;
  children: ReactNode;
}) {
  return <ProjectFilesContext value={store}>{children}</ProjectFilesContext>;
}

export function useProjectFiles() {
  const store = useContext(ProjectFilesContext);
  if (!store) throw new Error("Missing project files provider");
  return store;
}
