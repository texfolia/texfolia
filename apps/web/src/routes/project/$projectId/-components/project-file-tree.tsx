import {
  type Icon,
  IconBooks,
  IconChevronRight,
  IconFile,
  IconFileCode,
  IconFileSettings,
  IconFileSpreadsheet,
  IconFileText,
  IconFileTypeCsv,
  IconFileTypeJpg,
  IconFileTypePdf,
  IconFileTypePng,
  IconFileTypeSvg,
  IconFileTypeZip,
  IconFileVector,
  IconFolder,
  IconFolderOpen,
  IconMarkdown,
  IconPhoto,
  IconStarFilled,
  IconTex,
} from "@tabler/icons-react";
import { useMemo, useRef, useState, type DragEvent } from "react";

import { Button } from "#/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar";
import {
  isMainFileCandidate,
  projectPaths,
  renamedProjectNodes,
} from "#/lib/projects";
import type { ProjectNode } from "#/lib/projects/project.functions";
import { droppedEntries } from "#/lib/storage/browser";
import { useProjectFiles } from "#/providers/project-files-provider";

import { ProjectNodeActions } from "./project-node-actions";

const fileIcons = new Map<string, Icon>(
  [
    { extensions: ["tex", "ltx", "latex"], icon: IconTex },
    { extensions: ["bib"], icon: IconBooks },
    {
      extensions: [
        "sty",
        "cls",
        "clo",
        "bst",
        "bbx",
        "cbx",
        "lbx",
        "cfg",
        "def",
        "json",
        "yaml",
        "yml",
        "toml",
        "ini",
      ],
      icon: IconFileSettings,
    },
    { extensions: ["pdf"], icon: IconFileTypePdf },
    { extensions: ["png"], icon: IconFileTypePng },
    { extensions: ["jpg", "jpeg"], icon: IconFileTypeJpg },
    { extensions: ["svg"], icon: IconFileTypeSvg },
    { extensions: ["eps", "ps", "ai"], icon: IconFileVector },
    {
      extensions: ["gif", "webp", "avif", "bmp", "tif", "tiff", "ico"],
      icon: IconPhoto,
    },
    { extensions: ["csv"], icon: IconFileTypeCsv },
    {
      extensions: ["tsv", "dat", "xls", "xlsx", "ods"],
      icon: IconFileSpreadsheet,
    },
    { extensions: ["md", "markdown"], icon: IconMarkdown },
    {
      extensions: [
        "py",
        "r",
        "jl",
        "lua",
        "sh",
        "js",
        "jsx",
        "ts",
        "tsx",
        "html",
        "css",
        "xml",
      ],
      icon: IconFileCode,
    },
    {
      extensions: ["zip", "gz", "tar", "tgz", "bz2", "xz", "7z", "rar"],
      icon: IconFileTypeZip,
    },
    {
      extensions: [
        "txt",
        "log",
        "aux",
        "bbl",
        "blg",
        "toc",
        "lof",
        "lot",
        "out",
      ],
      icon: IconFileText,
    },
  ].flatMap(({ extensions, icon }) =>
    extensions.map((extension): [string, Icon] => [extension, icon]),
  ),
);

const nodeDragType = "application/x-texfolia-node";

function ProjectFileIcon({ name, kind }: Pick<ProjectNode, "name" | "kind">) {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const FileIcon =
    fileIcons.get(extension) ?? (kind === "text" ? IconFileText : IconFile);
  // oxlint-disable-next-line react/static-components -- Looked up, not created.
  return <FileIcon aria-hidden="true" />;
}

export function ProjectFileTree({
  nodes,
  activeId,
  mainId,
  isPending,
  onOpen,
  canManage = false,
  onCreate,
  onUpload,
  onDropFiles,
  onDownload,
}: {
  onCreate: (kind: "text" | "folder", parentId: string) => void;
  onUpload: (parentId: string) => void;
  onDropFiles: (
    parentId: string,
    entries: Array<FileSystemEntry | File>,
  ) => void;
  onDownload: (node: ProjectNode) => void;
  canManage?: boolean;
  nodes: ProjectNode[];
  activeId: string | undefined;
  /** The main document, which is marked. */
  mainId?: string;
  isPending: (id: string) => boolean;
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
  const files = useProjectFiles();
  const dragged = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const paths = useMemo(() => projectPaths(nodes), [nodes]);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root = children.get(null)?.find((node) => node.kind === "folder");

  function movable(node: ProjectNode) {
    return (
      canManage &&
      node.parentId !== null &&
      node.projectId !== "out" &&
      !isPending(node.id) &&
      moving === null
    );
  }

  function mainAction(node: ProjectNode) {
    const path = paths.get(node.id);
    return node.kind === "text" &&
      node.id !== mainId &&
      node.projectId !== "out" &&
      path &&
      isMainFileCandidate(path)
      ? () => files.setMainFile(path)
      : undefined;
  }

  // Folders accept drops on themselves; files forward drops to their folder.
  function dropFolder(event: DragEvent, node: ProjectNode | undefined) {
    const folder =
      node?.kind === "folder" ? node : byId.get(node?.parentId ?? "");
    if (!canManage || !folder || folder.projectId === "out" || moving) return;
    const types = event.dataTransfer.types;
    if (types.includes(nodeDragType)) {
      // Reject the item's own subtree; the server repeats this check.
      for (
        let id: string | null = folder.id;
        id;
        id = byId.get(id)?.parentId ?? null
      )
        if (id === dragged.current) return;
      return folder;
    }
    if (types.includes("Files")) return folder;
  }

  function dragOver(event: DragEvent, node: ProjectNode | undefined) {
    const folder = dropFolder(event, node);
    if (!folder) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
      nodeDragType,
    )
      ? "move"
      : "copy";
    setDropTarget(folder.id);
  }

  function drop(event: DragEvent, node: ProjectNode | undefined) {
    const folder = dropFolder(event, node);
    setDropTarget(null);
    if (!folder) return;
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData(nodeDragType);
    if (!id) {
      onDropFiles(folder.id, droppedEntries(event.dataTransfer));
      return;
    }
    const item = byId.get(id);
    if (item && item.parentId !== folder.id) void move(item, folder.id);
  }

  async function move(node: ProjectNode, parentId: string) {
    setError("");
    setMoving(node.id);
    try {
      renamedProjectNodes(
        nodes.filter((item) => item.projectId !== "out"),
        node.id,
        node.name,
        parentId,
      );
      await files.rename(node.id, node.name, parentId);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The file could not be moved. Try again.",
      );
    } finally {
      setMoving(null);
    }
  }

  function dragProps(node: ProjectNode) {
    return {
      draggable: movable(node),
      onDragStart: (event: DragEvent) => {
        event.dataTransfer.setData(nodeDragType, node.id);
        event.dataTransfer.effectAllowed = "move";
        dragged.current = node.id;
      },
      onDragEnd: () => {
        dragged.current = null;
        setDropTarget(null);
      },
    };
  }

  function branch(parentId: string | null, depth = 0) {
    return (
      <SidebarMenu
        className="m-0 gap-0 p-0"
        aria-label={parentId === null ? "Project files" : undefined}
      >
        {children.get(parentId)?.map((node) => (
          <SidebarMenuItem
            key={node.id}
            className="group/node data-drop-target:bg-sidebar-accent/60 relative"
            data-drop-target={dropTarget === node.id ? "" : undefined}
            onDragOver={(event) => dragOver(event, node)}
            onDrop={(event) => drop(event, node)}
          >
            <ProjectNodeActions
              node={node}
              nodes={nodes}
              canManage={
                canManage &&
                node.projectId !== "out" &&
                !isPending(node.id) &&
                moving !== node.id
              }
              onOpen={() => onOpen(node, true)}
              onDownload={() => onDownload(node)}
              onCreate={(kind) => onCreate(kind, node.id)}
              onUpload={() => onUpload(node.id)}
              onSetMain={mainAction(node)}
            >
              {node.kind === "folder" ? (
                <Collapsible defaultOpen className="group/folder">
                  <CollapsibleTrigger
                    disabled={isPending(node.id) || moving === node.id}
                    {...dragProps(node)}
                    render={
                      <SidebarMenuButton
                        size="sm"
                        className="h-6 rounded-none p-0"
                      />
                    }
                    style={{ paddingLeft: depth * 14 }}
                  >
                    <IconChevronRight className="transition-transform in-aria-expanded:rotate-90" />
                    <IconFolder className="in-aria-expanded:hidden" />
                    <IconFolderOpen className="hidden in-aria-expanded:block" />
                    <span>{node.name}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {branch(node.id, depth + 1)}
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <SidebarMenuButton
                  size="sm"
                  className="h-6 rounded-none p-0"
                  disabled={isPending(node.id) || moving === node.id}
                  {...dragProps(node)}
                  style={{ paddingLeft: 14 + depth * 14 }}
                  isActive={activeId === node.id}
                  aria-current={activeId === node.id ? "true" : undefined}
                  title={
                    node.id === mainId
                      ? `${node.name} (main document)`
                      : node.name
                  }
                  onClick={(event) => onOpen(node, event.detail === 0)}
                  onDoubleClick={() => onOpen(node, true)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight") {
                      event.preventDefault();
                      onOpen(node, true);
                    }
                  }}
                >
                  <ProjectFileIcon name={node.name} kind={node.kind} />
                  <span className="min-w-0 truncate">{node.name}</span>
                  {node.id === mainId && (
                    <IconStarFilled
                      aria-hidden="true"
                      className="text-muted-foreground mr-2 ml-auto size-3!"
                    />
                  )}
                </SidebarMenuButton>
              )}
            </ProjectNodeActions>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    );
  }

  return nodes.length ? (
    // Drops below the last item land in the project root.
    <div
      className="min-h-full"
      onDragOver={(event) => dragOver(event, root)}
      onDrop={(event) => drop(event, root)}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDropTarget(null);
      }}
    >
      {branch(null)}
      <Dialog
        open={!!error}
        onOpenChange={(open) => {
          if (!open) setError("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move failed</DialogTitle>
            <DialogDescription role="alert">{error}</DialogDescription>
          </DialogHeader>
          <Button variant="ghost" onClick={() => setError("")}>
            Close
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  ) : (
    <p className="text-muted-foreground text-xs">No files in this project.</p>
  );
}
