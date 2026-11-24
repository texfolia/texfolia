import {
  createContext,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";

import { projectNameSchema } from "#/lib/projects";
import {
  createProject,
  getProjects,
  trashProject,
  type Project,
} from "#/lib/projects/project.functions";
import { createRpcCollection } from "#/lib/rpc-collection";

type ProjectsPage = { projects: Project[]; nextCursor: string | null };

export function createProjectsStore({
  initial,
  ownerId,
}: {
  initial: ProjectsPage;
  ownerId: string;
}) {
  const projects = createRpcCollection({
    initial: initial.projects,
    insert: (row) => createProject({ data: { id: row.id, name: row.name } }),
    remove: (row) => trashProject({ data: { projectId: row.id } }),
  });
  // Pagination state lives outside the collection, so components subscribe to
  // it separately through useProjectsPagination. A failed page stops infinite
  // scrolling until the viewer retries, so a broken request cannot loop.
  let pagination = {
    nextCursor: initial.nextCursor,
    loading: false,
    failed: false,
  };
  let pages = 1;
  const listeners = new Set<() => void>();
  const setPagination = (next: Partial<typeof pagination>) => {
    pagination = { ...pagination, ...next };
    for (const listener of listeners) listener();
  };

  return {
    ownerId,
    projects,
    pagination: {
      get: () => pagination,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async loadMore() {
      const cursor = pagination.nextCursor;
      if (!cursor || pagination.loading) return;
      setPagination({ loading: true, failed: false });
      try {
        const page = await getProjects({ data: { cursor } });
        projects.utils.append(page.projects);
        pages += 1;
        setPagination({ nextCursor: page.nextCursor, loading: false });
      } catch {
        setPagination({ loading: false, failed: true });
      }
    },
    // Reload as many pages as the viewer has already loaded.
    async refresh() {
      const rows: Project[] = [];
      let cursor: string | null | undefined;
      for (let loaded = 0; loaded < pages; loaded += 1) {
        const page = await getProjects({
          data: cursor ? { cursor } : undefined,
        });
        rows.push(...page.projects);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      projects.utils.replace(rows);
      setPagination({ nextCursor: cursor ?? null, failed: false });
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
          spellcheckLanguage: "en-US",
          collaborators: [],
          owner: null,
          people: [],
          tags: [],
          canWrite: true,
          canManage: true,
        })
        .when("settled");
      return id;
    },
    // Moves the project to the trash.
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

export function useProjectsPagination() {
  const { pagination } = useProjects();
  return useSyncExternalStore(
    pagination.subscribe,
    pagination.get,
    pagination.get,
  );
}
