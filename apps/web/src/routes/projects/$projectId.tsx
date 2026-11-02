import "dockview-react/dist/styles/dockview.css";
import { createFileRoute } from "@tanstack/react-router";

import { Button } from "#/components/ui/button";
import { Collapsible } from "#/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarProvider,
} from "#/components/ui/sidebar";
import { Toolbar, ToolbarButton } from "#/components/ui/toolbar";

export const Route = createFileRoute("/projects/$projectId")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider>
      <Sidebar variant="inset">
        <SidebarHeader></SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Project</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <Collapsible></Collapsible>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter></SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="border-b p-2">
          <Toolbar>
            <ToolbarButton render={<Button />}>Compile</ToolbarButton>
          </Toolbar>
        </header>
        <main className="flex size-full"></main>
      </SidebarInset>
    </SidebarProvider>
  );
}
