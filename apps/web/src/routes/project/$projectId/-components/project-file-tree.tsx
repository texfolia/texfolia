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
  IconTex,
} from "@tabler/icons-react";
import { useMemo } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar";
import type { ProjectNode } from "#/lib/project.functions";

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

function ProjectFileIcon({ name, kind }: Pick<ProjectNode, "name" | "kind">) {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const FileIcon =
    fileIcons.get(extension) ?? (kind === "text" ? IconFileText : IconFile);
  return <FileIcon aria-hidden="true" />;
}

export function ProjectFileTree({
  nodes,
  activeId,
  isPending,
  onOpen,
  canManage = false,
  onCreate,
  onUpload,
  onDownload,
}: {
  onCreate: (kind: "text" | "folder", parentId: string) => void;
  onUpload: (parentId: string) => void;
  onDownload: (node: ProjectNode) => void;
  canManage?: boolean;
  nodes: ProjectNode[];
  activeId: string | undefined;
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

  function branch(parentId: string | null, depth = 0) {
    return (
      <SidebarMenu
        className="m-0 gap-0 p-0"
        aria-label={parentId === null ? "Project files" : undefined}
      >
        {children.get(parentId)?.map((node) => (
          <SidebarMenuItem key={node.id} className="group/node relative">
            <ProjectNodeActions
              node={node}
              nodes={nodes}
              canManage={
                canManage && node.projectId !== "out" && !isPending(node.id)
              }
              onOpen={() => onOpen(node, true)}
              onDownload={() => onDownload(node)}
              onCreate={(kind) => onCreate(kind, node.id)}
              onUpload={() => onUpload(node.id)}
            >
              {node.kind === "folder" ? (
                <Collapsible defaultOpen className="group/folder">
                  <CollapsibleTrigger
                    disabled={isPending(node.id)}
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
                  disabled={isPending(node.id)}
                  style={{ paddingLeft: 14 + depth * 14 }}
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
                  <ProjectFileIcon name={node.name} kind={node.kind} />
                  <span>{node.name}</span>
                </SidebarMenuButton>
              )}
            </ProjectNodeActions>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    );
  }

  return nodes.length ? (
    branch(null)
  ) : (
    <p className="text-muted-foreground text-xs">No files in this project.</p>
  );
}
