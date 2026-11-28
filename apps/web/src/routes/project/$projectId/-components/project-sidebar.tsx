import { IconX } from "@tabler/icons-react";
import { useMemo, useState, type RefObject } from "react";

import { lazyPanel } from "#/components/lazy-panel";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#/components/ui/dialog";
import { useHasBeen } from "#/hooks/use-has-been";
import { buildFileUrl } from "#/lib/compile/build";
import type { ProjectNode } from "#/lib/projects/project.functions";
import type { SourceFiles } from "#/lib/storage";
import { downloadFile } from "#/lib/storage/browser";
import { type SidebarView } from "#/lib/workspace/workspace-layout";
import { useProjectFiles } from "#/providers/project-files-provider";
import {
  useWorkspace,
  useWorkspaceActions,
  useWorkspaceBuild,
} from "#/providers/workspace-provider";

import { CreateNodeForm, type CreateNodeHandle } from "./create-node-form";
import { generatedTreeNodes } from "./generated-files";
import { ProjectExport, type ProjectExportHandle } from "./project-export";
import { ProjectFileTree } from "./project-file-tree";
import type { SearchRequest } from "./project-search";
import { UploadSource, type UploadSourceHandle } from "./upload-source";

const GitPanel = lazyPanel("Git", async () => {
  const { GitPanel } = await import("./git-panel");
  return GitPanel;
});
const ProjectCollaboration = lazyPanel("Collaboration", async () => {
  const { ProjectCollaboration } = await import("./project-collaboration");
  return ProjectCollaboration;
});
const ProjectComments = lazyPanel("Comments", async () => {
  const { ProjectComments } = await import("./project-comments");
  return ProjectComments;
});
const ProjectOutline = lazyPanel("The outline", async () => {
  const { ProjectOutline } = await import("./project-outline");
  return ProjectOutline;
});
const ProjectSearch = lazyPanel("Search", async () => {
  const { ProjectSearch } = await import("./project-search");
  return ProjectSearch;
});

export function ProjectSidebar({
  name,
  nodes,
  activeId,
  ready,
  open,
  onOpen,
  onOpenGenerated,
  sources,
  view,
  onClose,
  searchRequest,
  createRef,
  uploadRef,
  exportRef,
}: {
  name: string;
  nodes: ProjectNode[];
  activeId: string | undefined;
  ready: boolean;
  open: boolean;
  onOpen: (node: ProjectNode, permanent: boolean) => void;
  onOpenGenerated: (path: string, permanent: boolean) => void;
  sources: () => Promise<SourceFiles>;
  view: SidebarView;
  onClose: () => void;
  searchRequest: SearchRequest;
  createRef: RefObject<CreateNodeHandle | null>;
  uploadRef: RefObject<UploadSourceHandle | null>;
  exportRef: RefObject<ProjectExportHandle | null>;
}) {
  const files = useProjectFiles();
  const { projectId, drafts } = useWorkspaceActions();
  const { canWrite, main } = useWorkspace();
  const { build } = useWorkspaceBuild();
  const root = nodes.find((node) => node.kind === "folder" && !node.parentId);
  const tree = useMemo(
    () => [...nodes, ...generatedTreeNodes(build, root?.id)],
    [nodes, build, root?.id],
  );
  const [error, setError] = useState("");
  const searching = open && view === "search";
  const [searchRestored] = useState(searching);
  const searchUsed = useHasBeen(searching);
  async function download(node: ProjectNode) {
    setError("");
    try {
      const draft = drafts.get(node.id);
      if (node.kind === "text" && draft) {
        downloadFile(
          new Blob([draft.value], { type: "text/plain;charset=utf-8" }),
          node.name,
        );
        return;
      }
      const artifact = node.id.startsWith("out:")
        ? build?.artifacts?.files.find((file) => `out:${file.path}` === node.id)
        : undefined;
      const url = artifact
        ? buildFileUrl(projectId, artifact)
        : `/api/sources/${projectId}/${node.id}`;
      const response = await fetch(url);
      if (!response.ok)
        throw new Error("Could not download this file. Try again.");
      downloadFile(await response.blob(), node.name);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Download failed.");
    }
  }
  return (
    <aside
      id="project-sidebar"
      aria-label="Project sidebar"
      className="bg-sidebar text-sidebar-foreground flex h-full min-w-0 flex-col"
    >
      <header
        hidden={view === "files"}
        className="flex h-9 shrink-0 items-center gap-2 border-b px-2 [&[hidden]]:hidden"
      >
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium">
          {
            {
              files: "Files",
              outline: "Outline",
              search: "Search",
              git: "Git",
              comments: "Comments",
              collaboration: "Collaboration",
            }[view]
          }
        </h2>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close project sidebar"
          onClick={onClose}
        >
          <IconX />
        </Button>
      </header>
      <div
        hidden={view !== "files"}
        className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
      >
        <div className="min-h-0 flex-1 overflow-auto">
          <ProjectFileTree
            nodes={tree}
            canManage={canWrite}
            activeId={activeId}
            mainId={main?.id}
            isPending={(id) => files.nodes.get(id)?.$hasPendingWrites ?? false}
            onOpen={(node, permanent) =>
              node.id.startsWith("out:")
                ? onOpenGenerated(node.id.slice(4), permanent)
                : onOpen(node, permanent)
            }
            onCreate={(kind, parentId) =>
              createRef.current?.start(kind, parentId)
            }
            onUpload={(parentId) => uploadRef.current?.open(parentId)}
            onDropFiles={(parentId, entries) =>
              uploadRef.current?.drop(parentId, entries)
            }
            onDownload={(node) => void download(node)}
          />
        </div>
      </div>
      {ready && canWrite && (
        <>
          <CreateNodeForm
            hideTrigger
            ref={createRef}
            nodes={nodes}
            activeId={activeId}
            onCreated={onOpen}
          />
          <UploadSource
            hideTrigger
            ref={uploadRef}
            nodes={nodes}
            activeId={activeId}
            onCreated={onOpen}
          />
        </>
      )}
      <ProjectExport ref={exportRef} name={name} sources={sources} />
      <Dialog
        open={!!error}
        onOpenChange={(open) => {
          if (!open) setError("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Download failed</DialogTitle>
            <DialogDescription role="alert">{error}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
      {view === "outline" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <ProjectOutline open={open} />
        </div>
      )}
      {/* Stays mounted so the query survives switching views. */}
      <div
        hidden={view !== "search"}
        className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
      >
        {searchUsed && (
          <ProjectSearch
            active={searching}
            restored={searchRestored}
            request={searchRequest}
          />
        )}
      </div>
      {view === "git" && (
        <div className="min-h-0 flex-1 overflow-auto">
          {ready && <GitPanel visible={open} />}
        </div>
      )}
      {view === "comments" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <ProjectComments />
        </div>
      )}
      {view === "collaboration" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <ProjectCollaboration />
        </div>
      )}
    </aside>
  );
}
