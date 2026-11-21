import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { z } from "zod";

import {
  projectMetadataSchema,
  type ProjectMetadata,
} from "#/lib/project-metadata";
import {
  createProjectNode,
  renameProjectNode,
} from "#/lib/project-node.functions";
import { createNodeSchema } from "#/lib/project-node.schema";
import { newProjectNodePath } from "#/lib/project-paths";
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
  let mutation = 0;
  let refreshQueue = Promise.resolve();
  let knownNodeIds = new Set(initial.map((node) => node.id));
  let status: {
    canWrite: boolean | undefined;
    error: string;
    deleted: ReadonlySet<string>;
    commentsVersion: string | undefined;
  } = {
    canWrite: undefined,
    error: "",
    deleted: new Set(),
    commentsVersion: undefined,
  };
  const listeners = new Set<() => void>();
  function setStatus(next: typeof status) {
    if (
      next.canWrite === status.canWrite &&
      next.error === status.error &&
      next.deleted === status.deleted &&
      next.commentsVersion === status.commentsVersion
    )
      return;
    status = next;
    for (const listener of listeners) listener();
  }
  function markDeleted(ids: Iterable<string>) {
    const deleted = new Set(status.deleted);
    for (const id of ids) deleted.add(id);
    if (deleted.size !== status.deleted.size) setStatus({ ...status, deleted });
  }
  const pending = new Set<Promise<unknown>>();
  async function write<T>(operation: () => Promise<T>) {
    mutation++;
    const promise = operation();
    pending.add(promise);
    try {
      return await promise;
    } finally {
      pending.delete(promise);
      mutation++;
    }
  }
  const nodes = createRpcCollection<ProjectNode>({
    initial,
    insert: (row) =>
      write(async () => {
        const input = createNodeSchema.parse(row);
        knownNodeIds.add(row.id);
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
      }),
    remove: (row) =>
      write(async () => {
        await deleteProjectNode({ data: { projectId, nodeId: row.id } });
        markDeleted([row.id]);
      }),
  });

  type SourceVersion = (typeof sourceVersions)[string];
  return {
    nodes,
    sourceVersions: sourceVersions as Readonly<typeof sourceVersions>,
    /** Copies the known versions so a long operation reads a consistent set. */
    snapshotSourceVersions: () => ({ ...sourceVersions }),
    /**
     * Records a version the server acknowledged. An acknowledgement that
     * arrives out of order is ignored so it cannot roll the version back.
     */
    recordSourceVersion(id: string, version: SourceVersion) {
      const previous = sourceVersions[id];
      if (previous && previous.updatedAt > version.updatedAt) return false;
      sourceVersions[id] = {
        objectKey: version.objectKey,
        updatedAt: version.updatedAt,
      };
      return true;
    },
    createdTextSources,
    getStatus: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh(signal?: AbortSignal): Promise<ProjectMetadata> {
      const run = async () => {
        // A response begun before an acknowledged local write must not undo it.
        for (;;) {
          await Promise.allSettled(pending);
          signal?.throwIfAborted();
          const started = mutation;
          const versionsAtStart = { ...sourceVersions };
          const response = await fetch(`/api/projects/${projectId}/metadata`, {
            cache: "no-store",
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
              : AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            const denied = response.status === 401 || response.status === 404;
            const error = denied
              ? "Project access is no longer available. Local drafts are kept in this browser."
              : "Could not synchronize project files. Try again when connected.";
            if (denied) setStatus({ ...status, canWrite: false, error });
            throw new Error(error);
          }
          const metadata = projectMetadataSchema.parse(await response.json());
          signal?.throwIfAborted();
          if (started !== mutation || pending.size) continue;
          const ids = new Set(metadata.nodes.map((node) => node.id));
          markDeleted([...knownNodeIds].filter((id) => !ids.has(id)));
          knownNodeIds = ids;
          for (const id of Object.keys(sourceVersions))
            if (!ids.has(id)) delete sourceVersions[id];
          for (const [id, version] of Object.entries(metadata.sourceVersions))
            if (sourceVersions[id] === versionsAtStart[id])
              sourceVersions[id] = version;
          nodes.utils.replace(metadata.nodes);
          setStatus({
            ...status,
            canWrite: metadata.canWrite,
            error: "",
            commentsVersion: metadata.commentsVersion,
          });
          return metadata;
        }
      };
      const next = refreshQueue.then(run);
      refreshQueue = next.then(
        () => {},
        () => {},
      );
      return next;
    },
    async rename(nodeId: string, name: string, parentId: string) {
      await write(() =>
        renameProjectNode({ data: { projectId, nodeId, name, parentId } }),
      );
      await this.refresh();
    },
    async create(
      input: Pick<NewNode, "parentId" | "name" | "kind" | "content">,
    ) {
      const row = createNodeSchema.parse({
        ...input,
        id: crypto.randomUUID(),
        projectId,
      });
      newProjectNodePath(nodes.toArray, row.parentId, row.name);
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
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || controller.signal.aborted) return;
      clearTimeout(timer);
      refreshing = true;
      try {
        await store.refresh(controller.signal);
      } catch {
        // Offline sessions retain their metadata and Yjs recovery cache.
      } finally {
        refreshing = false;
        if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [store]);
  return <ProjectFilesContext value={store}>{children}</ProjectFilesContext>;
}

export function useProjectFiles() {
  const store = useContext(ProjectFilesContext);
  if (!store) throw new Error("Missing project files provider");
  return store;
}
