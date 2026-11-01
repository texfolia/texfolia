import { createFileRoute } from "@tanstack/react-router";
import CodeMirror from "@uiw/react-codemirror";

import { ProjectSidebar } from "#/components/project-sidebar";
import { Button } from "#/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#/components/ui/resizable";
import { SidebarInset, SidebarProvider } from "#/components/ui/sidebar";
export const Route = createFileRoute("/projects/$projectId")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider>
      <ProjectSidebar />
      <SidebarInset>
        <header className="border-b p-2">
          <Button>Compile</Button>
        </header>
        <main className="flex size-full">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel>
              <CodeMirror extensions={[]} value="" className="h-full" />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel>Two</ResizablePanel>
          </ResizablePanelGroup>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
