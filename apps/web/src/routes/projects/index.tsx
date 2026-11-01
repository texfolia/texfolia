import { createFileRoute } from "@tanstack/react-router";

import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
} from "#/components/ui/sidebar";
import { getProjects } from "#/lib/projects.functions";

export const Route = createFileRoute("/projects/")({
  head: () => ({
    meta: [
      {
        title: "Your Projects | Texfolia",
      },
    ],
  }),
  loader: async () => {
    return { projects: await getProjects() };
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider>
      <Sidebar variant="inset" />
      <SidebarInset>
        <main></main>
      </SidebarInset>
    </SidebarProvider>
  );
}
