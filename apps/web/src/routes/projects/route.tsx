import { createFileRoute, redirect } from "@tanstack/react-router";
import { SidebarProvider, useSidebar } from "@texfolia/ui/sidebar";

import { getProjects } from "#/lib/projects/project.functions";
import { ProjectsProvider } from "#/providers/projects-provider";
import { SettingsProvider } from "#/providers/settings-provider";
import { useAppShortcut } from "#/providers/shortcuts-provider";
import { ThemeProvider } from "#/providers/theme-provider";

import { ProjectList } from "./-components/project-list";

export const Route = createFileRoute("/projects")({
  ssr: false,
  // Always return the key: the router keeps raw search values a validator omits.
  validateSearch: (search: Record<string, unknown>): { view?: "trash" } => ({
    view: search.view === "trash" ? "trash" : undefined,
  }),
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
    // Loaders are part of every page's first bundle; the store is not.
    const [initial, { createProjectsStore }] = await Promise.all([
      getProjects(),
      import("#/providers/projects-provider"),
    ]);
    const store = createProjectsStore({ initial, ownerId: context.user.id });
    await store.projects.preload();
    return { store };
  },
  component: ProjectsPage,
});

function ProjectsPage() {
  const { store } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const { view } = Route.useSearch();
  return (
    <ThemeProvider userId={user.id}>
      <ProjectsProvider store={store}>
        <SettingsProvider userId={user.id}>
          <SidebarProvider>
            <SidebarShortcut />
            <ProjectList user={user} view={view} />
          </SidebarProvider>
        </SettingsProvider>
      </ProjectsProvider>
    </ThemeProvider>
  );
}

function SidebarShortcut() {
  const { toggleSidebar } = useSidebar();
  useAppShortcut("sidebar", toggleSidebar);
  return null;
}
