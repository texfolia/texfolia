import { ChevronRight, File, FileText, Folder, FolderOpen } from "lucide-react";
import { useMemo } from "react";

import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar";
import type { getProject } from "#/lib/projects.functions";

export type ProjectNode = Awaited<
  ReturnType<typeof getProject>
>["nodes"][number];

export function ProjectFileTree({
  nodes,
  activeId,
  onOpen,
}: {
  nodes: ProjectNode[];
  activeId: string | undefined;
  onOpen: (node: ProjectNode, permanent: boolean) => void;
}) {
  const children = useMemo(() => {
    const result = new Map<string | null, ProjectNode[]>();
    for (const node of nodes) {
      const siblings = result.get(node.parentId) ?? [];
      siblings.push(node);
      result.set(node.parentId, siblings);
    }
    for (const siblings of result.values()) {
      siblings.sort(
        (a, b) =>
          Number(b.kind === "folder") - Number(a.kind === "folder") ||
          a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    }
    return result;
  }, [nodes]);

  function branch(parentId: string | null, depth = 0) {
    return (
      <SidebarMenu aria-label={parentId === null ? "Project files" : undefined}>
        {children.get(parentId)?.map((node) => (
          <SidebarMenuItem key={node.id}>
            {node.kind === "folder" ? (
              <Collapsible defaultOpen className="group/folder">
                <CollapsibleTrigger
                  render={<SidebarMenuButton />}
                  style={{ paddingLeft: 8 + depth * 14 }}
                >
                  <ChevronRight className="transition-transform in-aria-expanded:rotate-90" />
                  <Folder className="in-aria-expanded:hidden" />
                  <FolderOpen className="hidden in-aria-expanded:block" />
                  <span>{node.name}</span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  {branch(node.id, depth + 1)}
                </CollapsiblePanel>
              </Collapsible>
            ) : (
              <SidebarMenuButton
                style={{ paddingLeft: 22 + depth * 14 }}
                isActive={activeId === node.id}
                aria-current={activeId === node.id ? "true" : undefined}
                title={node.name}
                onClick={(event) => onOpen(node, event.detail === 0)}
                onDoubleClick={() => onOpen(node, true)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    onOpen(node, true);
                  }
                }}
              >
                {node.kind === "text" ? <FileText /> : <File />}
                <span>{node.name}</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    );
  }

  return nodes.length ? (
    branch(null)
  ) : (
    <p className="px-2 py-3 text-xs text-muted-foreground">
      No files in this project.
    </p>
  );
}
