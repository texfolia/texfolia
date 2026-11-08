import { createContext, type ReactNode, useContext } from "react";

import type { createProjectsStore } from "./collections";

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
