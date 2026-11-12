import { createContext, type ReactNode, useContext } from "react";
import type { z } from "zod";

import { createProjectNode } from "#/lib/project-node.functions";
import { createNodeSchema } from "#/lib/project-node.schema";
import { decodeSource } from "#/lib/project-source";
import { deleteProjectNode } from "#/lib/project-source.functions";
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
  const createdSources = new Map<
    string,
    {
      version: { objectKey: string | null; updatedAt: number };
      content: string;
    }
  >();
  const nodes = createRpcCollection<ProjectNode>({
    initial,
    insert: async (row) => {
      const input = createNodeSchema.parse(row);
      const created = await createProjectNode({ data: input });
      if (input.kind === "text")
        createdSources.set(created.id, {
          version: created.sourceVersion,
          content:
            input.content === undefined
              ? ""
              : new TextDecoder().decode(decodeSource(input.content)),
        });
      return created;
    },
    remove: (row) => deleteProjectNode({ data: { projectId, nodeId: row.id } }),
  });

  return {
    nodes,
    createdSources,
    async create(
      input: Pick<NewNode, "parentId" | "name" | "kind" | "content">,
    ) {
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
