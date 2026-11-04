import "dockview-react/dist/styles/dockview.css";
import { ClientOnly, createFileRoute, Link } from "@tanstack/react-router";
import {
  DockviewReact,
  type DockviewReadyEvent,
  themeLight,
} from "dockview-react";
import { ArrowLeft } from "lucide-react";
import { lazy, Suspense } from "react";

import { Editor } from "#/components/editor";
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "#/components/ui/sidebar";
import { Toolbar, ToolbarButton } from "#/components/ui/toolbar";

export const Route = createFileRoute("/projects/$projectId")({
  component: RouteComponent,
});

const PdfViewer = lazy(() => import("#/components/pdf"));

const components = {
  editor: () => <Editor />,
  pdf: () => (
    <div className="h-full overflow-auto">
      <Suspense fallback={<p className="p-4">Loading PDF viewer…</p>}>
        <PdfViewer />
      </Suspense>
    </div>
  ),
};

function onReady({ api }: DockviewReadyEvent) {
  api.addPanel({
    id: "editor",
    component: "editor",
    title: "Editor",
  });
  api.addPanel({
    id: "pdf",
    component: "pdf",
    title: "PDF Preview",
    position: { referencePanel: "editor", direction: "right" },
  });
}

function RouteComponent() {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <Link to="/projects">
                <SidebarMenuButton
                  render={<Button variant="ghost" className="justify-start" />}
                >
                  <ArrowLeft />
                  Back to Projects
                </SidebarMenuButton>
              </Link>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
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
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header className="shrink-0 border-b p-2">
          <Toolbar>
            <ToolbarButton render={<Button />}>Compile</ToolbarButton>
          </Toolbar>
        </header>
        <div className="min-h-0 flex-1">
          <ClientOnly>
            <DockviewReact
              className="size-full"
              theme={themeLight}
              components={components}
              onReady={onReady}
            />
          </ClientOnly>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
