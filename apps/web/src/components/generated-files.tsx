import { IconChevronRight, IconLock } from "@tabler/icons-react";
import { useMemo } from "react";

import { ProjectFileTree } from "#/components/project-file-tree";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";
import { SidebarMenuButton } from "#/components/ui/sidebar";
import type { ProjectNode } from "#/lib/project.functions";
import { useWorkspace } from "#/providers/workspace-provider";

export function GeneratedFiles({
  onOpen,
  activePath,
}: {
  onOpen: (path: string) => void;
  activePath?: string;
}) {
  const { build, stale } = useWorkspace();
  const manifest = build?.artifacts;
  const nodes = useMemo(() => {
    const result = new Map<string, ProjectNode>();
    for (const file of manifest?.files ?? []) {
      const parts = file.path.split("/");
      for (let index = 0; index < parts.length; index++) {
        const path = parts.slice(0, index + 1).join("/");
        result.set(path, {
          id: path,
          projectId: "out",
          parentId: index ? parts.slice(0, index).join("/") : null,
          name: parts[index]!,
          kind: index === parts.length - 1 ? "binary" : "folder",
        });
      }
    }
    return [...result.values()];
  }, [manifest]);
  return (
    <Collapsible defaultOpen className="border-t">
      <CollapsibleTrigger
        render={<SidebarMenuButton />}
        title="Generated build files (read-only)"
      >
        <IconChevronRight className="in-aria-expanded:rotate-90" />
        <IconLock aria-hidden="true" />
        <span>out/</span>
        {manifest && stale && (
          <span className="text-muted-foreground ml-auto text-xs">
            Out of date
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {manifest ? (
          <>
            <p
              className="text-muted-foreground px-2 py-1 text-xs"
              title={new Date(manifest.builtAt).toLocaleString()}
            >
              Built by {manifest.builtBy},{" "}
              {new Date(manifest.builtAt).toLocaleString()},{" "}
              {manifest.engine === "tectonic" ? "Tectonic" : manifest.engine}
            </p>
            {build?.current?.status === "failed" && (
              <p className="text-destructive px-3 pb-2 text-xs">
                Last compile failed. Open the log for details.
              </p>
            )}
            <ProjectFileTree
              nodes={nodes}
              activeId={activePath}
              isPending={() => false}
              onOpen={(node) => onOpen(node.id)}
            />
          </>
        ) : (
          <p className="text-muted-foreground px-2 py-1 text-xs">
            Compile to generate build files.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
