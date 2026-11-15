import {
  IconAlertCircle,
  IconFiles,
  IconHistory,
  IconFileTypePdf,
  IconX,
} from "@tabler/icons-react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { cn } from "cn";

import { editorChrome } from "#/components/editor-chrome";
import { SettingsDialog } from "#/components/settings-dialog";
import { Button } from "#/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "#/components/ui/sidebar";
import type { SourceFiles } from "#/lib/project-source";
import type { ProjectNode } from "#/lib/project.functions";
import { useProjectFiles } from "#/providers/project-files-provider";
import { useWorkspace } from "#/providers/workspace-provider";

import { CreateNodeForm } from "./create-node-form";
import { GeneratedFiles } from "./generated-files";
import { ProjectCollaboration } from "./project-collaboration";
import { ProjectExport } from "./project-export";
import { ProjectFileTree } from "./project-file-tree";
import { RepairSourcePaths } from "./repair-source-paths";
import { UploadSource } from "./upload-source";

export function ProjectSidebar({
  name,
  nodes,
  activeId,
  ready,
  onOpen,
  showProblems,
  onToggleProblems,
  onOpenGenerated,
  sources,
  onOpenHistory,
  onOpenPreview,
}: {
  name: string;
  onOpenHistory: () => void;
  onOpenPreview: () => void;
  nodes: ProjectNode[];
  activeId: string | undefined;
  ready: boolean;
  onOpen: (node: ProjectNode, permanent: boolean) => void;
  showProblems: boolean;
  onToggleProblems: () => void;
  onOpenGenerated: (path: string) => void;
  sources: () => Promise<SourceFiles>;
}) {
  const files = useProjectFiles();
  const { canWrite } = useWorkspace();
  const { setOpen, toggleSidebar, isMobile, setOpenMobile } = useSidebar();

  useHotkeys([{ hotkey: "Mod+B", callback: toggleSidebar }], {
    ignoreInputs: false,
    ignoreDefaultPrevented: true,
  });

  return (
    <Sidebar
      side="right"
      collapsible="icon"
      className="top-(--workspace-header-height) bottom-(--workspace-footer-height) h-auto overflow-hidden"
    >
      <div
        className={cn(
          "flex size-full flex-row-reverse [&_[data-slot=sidebar-footer]]:p-0",
          editorChrome,
        )}
      >
        <Sidebar
          collapsible="none"
          className="w-(--sidebar-width-icon)! shrink-0 border-l [--sidebar-foreground:var(--activity-foreground)] [--sidebar:var(--activity-background)]"
        >
          <SidebarContent className="gap-0">
            <SidebarGroup className="p-0">
              <SidebarMenu aria-label="Workspace navigation" className="gap-0">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    tooltip="Project files"
                    aria-label="Project files"
                    isActive
                    onClick={() => setOpen(true)}
                  >
                    <IconFiles />
                    <span className="sr-only">Project files</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    tooltip="PDF preview"
                    aria-label="PDF preview"
                    disabled={!ready}
                    onClick={onOpenPreview}
                  >
                    <IconFileTypePdf />
                    <span className="sr-only">PDF preview</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    tooltip="Document history"
                    aria-label="Document history"
                    disabled={!ready}
                    onClick={onOpenHistory}
                  >
                    <IconHistory />
                    <span className="sr-only">Document history</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    tooltip="Problems"
                    aria-label="Problems"
                    aria-expanded={showProblems}
                    onClick={onToggleProblems}
                  >
                    <IconAlertCircle />
                    <span className="sr-only">Problems</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SettingsDialog iconOnly variant="editor" />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <Sidebar
          collapsible="none"
          className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden"
        >
          <SidebarHeader className="h-8 flex-row items-center justify-between border-b px-2">
            <h2 className="text-xs font-medium">Files</h2>
            {isMobile && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Close project sidebar"
                onClick={() => setOpenMobile(false)}
              >
                <IconX />
              </Button>
            )}
          </SidebarHeader>
          <SidebarContent className="gap-0">
            <SidebarGroup className="p-0">
              <div className="flex flex-wrap items-center border-b">
                {ready && canWrite && (
                  <CreateNodeForm
                    nodes={nodes}
                    activeId={activeId}
                    onCreated={onOpen}
                  />
                )}
                {ready && canWrite && (
                  <UploadSource
                    nodes={nodes}
                    activeId={activeId}
                    onCreated={onOpen}
                  />
                )}
              </div>
              {ready && <RepairSourcePaths nodes={nodes} canWrite={canWrite} />}
              <SidebarGroupContent aria-busy={!ready}>
                <ProjectFileTree
                  canManage={canWrite}
                  nodes={nodes}
                  activeId={activeId}
                  isPending={(id) =>
                    files.nodes.get(id)?.$hasPendingWrites ?? false
                  }
                  onOpen={onOpen}
                />
                <GeneratedFiles
                  onOpen={onOpenGenerated}
                  activePath={
                    activeId?.startsWith("out:") ? activeId.slice(4) : undefined
                  }
                />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <div className="max-h-[40%] shrink-0 overflow-auto">
            <ProjectCollaboration />
          </div>
          <ProjectExport name={name} sources={sources} />
        </Sidebar>
      </div>
    </Sidebar>
  );
}
