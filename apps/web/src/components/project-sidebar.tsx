import { IconAlertCircle, IconFiles } from "@tabler/icons-react";
import { useHotkeys } from "@tanstack/react-hotkeys";

import {
  ProjectFileTree,
  type ProjectNode,
} from "#/components/project-file-tree";
import { SettingsDialog } from "#/components/settings-dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "#/components/ui/sidebar";

export function ProjectSidebar({
  name,
  nodes,
  activeId,
  ready,
  onOpen,
  showProblems,
  onToggleProblems,
}: {
  name: string;
  nodes: ProjectNode[];
  activeId: string | undefined;
  ready: boolean;
  onOpen: (node: ProjectNode, permanent: boolean) => void;
  showProblems: boolean;
  onToggleProblems: () => void;
}) {
  const { setOpen, toggleSidebar } = useSidebar();

  useHotkeys([{ hotkey: "Mod+B", callback: toggleSidebar }], {
    ignoreInputs: false,
    ignoreDefaultPrevented: true,
  });

  return (
    <Sidebar
      collapsible="icon"
      className="top-(--workspace-header-height) bottom-(--workspace-footer-height) h-auto overflow-hidden"
    >
      <div className="flex size-full">
        <Sidebar
          collapsible="none"
          className="w-(--sidebar-width-icon)! shrink-0 border-r"
        >
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu aria-label="Workspace navigation">
                <SidebarMenuItem>
                  <SidebarMenuButton
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
                <SettingsDialog iconOnly />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <Sidebar
          collapsible="none"
          className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden"
        >
          <SidebarHeader className="h-11 justify-center border-b px-4">
            <h2 className="text-sm font-medium">Files</h2>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel title={name}>{name}</SidebarGroupLabel>
              <SidebarGroupContent aria-busy={!ready}>
                <ProjectFileTree
                  nodes={nodes}
                  activeId={activeId}
                  onOpen={onOpen}
                />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </div>
    </Sidebar>
  );
}
