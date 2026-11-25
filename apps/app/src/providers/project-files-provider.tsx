import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { z } from "zod";

import {
  projectMetadataSchema,
  projectSourcesFingerprint,
  type ProjectMetadata,
  createNodeSchema,
  newProjectNodePath,
} from "#/lib/projects";
import {
  createProjectNode,
  renameProjectNode,
} from "#/lib/projects/project-node.functions";
import { deleteProjectNode } from "#/lib/projects/project-source.functions";
import {
  updateProjectMainFile,
  type ProjectDetails,
  type ProjectNode,
} from "#/lib/projects/project.functions";
import { createRpcCollection } from "#/lib/rpc-collection";
import { decodeSource } from "#/lib/storage";

type NewNode = z.input<typeof createNodeSchema>;

export function createProjectFilesStore({
  initial,
  projectId,
  initialSourceVersions,
  mainFile = null,
  commentsVersion,
  gitVersion,
}: {
  initial: ProjectNode[];
  projectId: string;
  initialSourceVersions: ProjectDetails["sourceVersions"];
  mainFile?: string | null;
  commentsVersion?: string;
  gitVersion?: string;
}) {
  const sourceVersions = { ...initialSourceVersions };
  const createdTextSources = new Map<string, string>();
  let mutation = 0;
  // The last response applied, while no local write has followed it.
  let applied: {
    etag: string;
    mutation: number;
    metadata: ProjectMetadata;
  } | null = null;
  let refreshQueue = Promise.resolve();
  let knownNodeIds = new Set(initial.map((node) => node.id));
  let status: {
    canWrite: boolean | undefined;
    /** The chosen main document's path. See `projectMainFile`. */
    mainFile: string | null;
    error: string;
    deleted: ReadonlySet<string>;
    commentsVersion: string | undefined;
    gitVersion: string | undefined;
    sourcesVersion: string;
  } = {
    canWrite: undefined,
    mainFile,
    error: "",
    deleted: new Set(),
    commentsVersion,
    gitVersion,
    sourcesVersion: projectSourcesFingerprint({
      nodes: initial,
      sourceVersions,
    }),
  };
  const listeners = new Set<() => void>();
  const refreshListeners = new Set<() => void>();
  function setStatus(next: typeof status) {
    if (
      next.canWrite === status.canWrite &&
      next.mainFile === status.mainFile &&
      next.error === status.error &&
      next.deleted === status.deleted &&
      next.commentsVersion === status.commentsVersion &&
      next.gitVersion === status.gitVersion &&
      next.sourcesVersion === status.sourcesVersion
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
        const nextNodes = [
          ...nodes.toArray.filter((node) => node.id !== created.id),
          {
            id: created.id,
            projectId: created.projectId,
            parentId: created.parentId,
            name: created.name,
            kind: created.kind,
          },
        ];
        setStatus({
          ...status,
          sourcesVersion: projectSourcesFingerprint({
            nodes: nextNodes,
            sourceVersions,
          }),
        });
        return created;
      }),
    remove: (row) =>
      write(async () => {
        await deleteProjectNode({ data: { projectId, nodeId: row.id } });
        delete sourceVersions[row.id];
        markDeleted([row.id]);
        setStatus({
          ...status,
          sourcesVersion: projectSourcesFingerprint({
            nodes: nodes.toArray.filter((node) => node.id !== row.id),
            sourceVersions,
          }),
        });
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
      if (previous?.objectKey !== version.objectKey)
        setStatus({
          ...status,
          sourcesVersion: projectSourcesFingerprint({
            nodes: nodes.toArray,
            sourceVersions,
          }),
        });
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
    /** Calls `listener` after each refresh, when versions may have changed. */
    onRefresh: (listener: () => void) => {
      refreshListeners.add(listener);
      return () => {
        refreshListeners.delete(listener);
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
          // Local writes may have changed what the last response left here.
          const known = applied?.mutation === started ? applied : null;
          const response = await fetch(`/api/projects/${projectId}/metadata`, {
            cache: "no-store",
            headers: known ? { "If-None-Match": known.etag } : {},
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
              : AbortSignal.timeout(10_000),
          });
          if (known && response.status === 304) {
            signal?.throwIfAborted();
            if (started !== mutation || pending.size) continue;
            for (const listener of refreshListeners) listener();
            return known.metadata;
          }
          if (!response.ok) {
            applied = null;
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
            mainFile: metadata.mainFile,
            error: "",
            commentsVersion: metadata.commentsVersion,
            gitVersion: metadata.gitVersion,
            sourcesVersion: projectSourcesFingerprint({
              nodes: metadata.nodes,
              sourceVersions,
            }),
          });
          const etag = response.headers.get("ETag");
          applied = etag ? { etag, mutation: started, metadata } : null;
          for (const listener of refreshListeners) listener();
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
    /** Chooses the main document, or the default when null. */
    async setMainFile(mainFile: string | null) {
      await write(() =>
        updateProjectMainFile({ data: { projectId, mainFile } }),
      );
      setStatus({ ...status, mainFile });
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
    // Hidden tabs do not poll; they refresh when they are shown again.
    const schedule = () => {
      clearTimeout(timer);
      if (!controller.signal.aborted && document.visibilityState !== "hidden")
        timer = setTimeout(refresh, 2000);
    };
    const poll = async () => {
      if (
        refreshing ||
        controller.signal.aborted ||
        document.visibilityState === "hidden"
      )
        return;
      clearTimeout(timer);
      refreshing = true;
      try {
        await store.refresh(controller.signal);
      } catch {
        // Offline sessions retain their metadata and Yjs recovery cache.
      } finally {
        refreshing = false;
        schedule();
      }
    };
    const refresh = () => void poll();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") clearTimeout(timer);
      else refresh();
    };
    // The route has just loaded this store.
    schedule();
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [store]);
  return <ProjectFilesContext value={store}>{children}</ProjectFilesContext>;
}

export function useProjectFiles() {
  const store = useContext(ProjectFilesContext);
  if (!store) throw new Error("Missing project files provider");
  return store;
}
