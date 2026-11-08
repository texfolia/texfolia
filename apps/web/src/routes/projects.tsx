import { createFileRoute, redirect } from "@tanstack/react-router";

import { ProjectList } from "#/components/project-list";
import { SidebarProvider } from "#/components/ui/sidebar";
import { getSession } from "#/lib/auth.functions";
import { getProjects } from "#/lib/project.functions";
import {
  createProjectsStore,
  ProjectsProvider,
} from "#/providers/projects-provider";
import { SettingsProvider } from "#/providers/settings-provider";

export const Route = createFileRoute("/projects")({
  ssr: false,
  head: () => ({
    meta: [
      {
        title: "Projects | Texfolia",
      },
    ],
  }),
  beforeLoad: async () => {
    const session = await getSession();

    if (!session) {
      throw redirect({
        to: "/login",
        search: {
          redirectTo: location.href,
        },
      });
    }

    return { user: session.user };
  },
  loader: async ({ context }) => {
    const store = createProjectsStore({
      initial: await getProjects(),
      ownerId: context.user.id,
    });
    await store.projects.preload();
    return { store };
  },
  component: ProjectsPage,
});

function ProjectsPage() {
  const { store } = Route.useLoaderData();
  return (
    <ProjectsProvider store={store}>
      <SettingsProvider>
        <SidebarProvider>
          <ProjectList />
        </SidebarProvider>
      </SettingsProvider>
    </ProjectsProvider>
  );
}
