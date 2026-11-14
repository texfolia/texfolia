import { createContext, type ReactNode, useContext } from "react";
import type { z } from "zod";

import { createProjectNode } from "#/lib/project-node.functions";
import { createNodeSchema } from "#/lib/project-node.schema";
import { decodeSource } from "#/lib/project-source";
import { deleteProjectNode } from "#/lib/project-source.functions";
import type { ProjectDetails, ProjectNode } from "#/lib/project.functions";
import { createRpcCollection } from "#/lib/rpc-collection";

type NewNode = z.input<typeof createNodeSchema>;

export function createProjectFilesStore({
  initial,
  projectId,
  initialSourceVersions,
}: {
  initial: ProjectNode[];
  projectId: string;
  initialSourceVersions: ProjectDetails["sourceVersions"];
}) {
  const sourceVersions = { ...initialSourceVersions };
  const createdTextSources = new Map<string, string>();
  const nodes = createRpcCollection<ProjectNode>({
    initial,
    insert: async (row) => {
      const input = createNodeSchema.parse(row);
      const created = await createProjectNode({ data: input });
      if (created.kind !== "folder")
        sourceVersions[created.id] = created.sourceVersion;
      if (input.kind === "text")
        createdTextSources.set(
          created.id,
          input.content === undefined
            ? ""
            : new TextDecoder().decode(decodeSource(input.content)),
        );
      return created;
    },
    remove: (row) => deleteProjectNode({ data: { projectId, nodeId: row.id } }),
  });

  return {
    nodes,
    sourceVersions,
    createdTextSources,
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
