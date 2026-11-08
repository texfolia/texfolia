import { createFileRoute, redirect } from "@tanstack/react-router";

import { SidebarProvider } from "#/components/ui/sidebar";
import { createProjectsStore } from "#/features/projects/collections";
import { ProjectsProvider } from "#/features/projects/context";
import { ProjectList } from "#/features/projects/project-list";
import { getProjects } from "#/features/projects/server";
import { SettingsProvider } from "#/hooks/use-settings";
import { getSession } from "#/lib/auth.functions";

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
