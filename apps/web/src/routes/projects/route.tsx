import { createFileRoute, redirect } from "@tanstack/react-router";

import { SidebarProvider } from "#/components/ui/sidebar";
import { getProjects } from "#/lib/project.functions";
import {
  createProjectsStore,
  ProjectsProvider,
} from "#/providers/projects-provider";
import { SettingsProvider } from "#/providers/settings-provider";
import { ThemeProvider } from "#/providers/theme-provider";

import { ProjectList } from "./-components/project-list";

export const Route = createFileRoute("/projects")({
  ssr: false,
  head: () => ({
    meta: [
      {
        title: "Projects | Texfolia",
      },
    ],
  }),
  beforeLoad: ({ location, context }) => {
    const user = context.appUser;
    if (!user) {
      throw redirect({
        to: "/login",
        search: {
          redirectTo: location.pathname,
        },
      });
    }

    return { user };
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
  const { user } = Route.useRouteContext();
  return (
    <ThemeProvider userId={user.id}>
      <ProjectsProvider store={store}>
        <SettingsProvider userId={user.id}>
          <SidebarProvider>
            <ProjectList />
          </SidebarProvider>
        </SettingsProvider>
      </ProjectsProvider>
    </ThemeProvider>
  );
}
