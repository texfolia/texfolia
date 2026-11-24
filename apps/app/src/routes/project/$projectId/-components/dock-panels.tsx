import { Button } from "@texfolia/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@texfolia/ui/context-menu";
import { cn } from "cn";
import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import { useMemo, useState } from "react";

import { type LatexProblem } from "#/lib/editor/latex/analysis";
import { downloadFile } from "#/lib/storage/browser";
import { useWorkspace } from "#/providers/workspace-provider";

import type { FilePanelParams } from "../-hooks/use-dock-panels";
import { DocumentEditor } from "./document-editor";
import type { EditorComments } from "./editor";
import { GeneratedFile } from "./generated-file";
import { MarkdownPreview } from "./markdown-preview";
import { ScratchpadEditor } from "./scratchpad-editor";
import { SourcePdf } from "./source-pdf";

const noProblems: LatexProblem[] = [];

export function FileEditor({
  params,
  api: panelApi,
}: IDockviewPanelProps<FilePanelParams>) {
  const workspace = useWorkspace();
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const draft = workspace.drafts.get(params.node.id);
  const path = workspace.paths.get(params.node.id) ?? params.node.name;
  const { comments } = workspace;
  const threads = comments.data?.threads;
  const openThreads = useMemo(
    () =>
      threads?.filter(
        (thread) => thread.nodeId === params.node.id && !thread.resolvedAt,
      ),
    [threads, params.node.id],
  );
  const editorComments = useMemo<EditorComments | undefined>(
    () =>
      openThreads
        ? {
            threads: openThreads,
            activeId: comments.activeId,
            onSelect: (id) => comments.selectThread(id, true),
            onAdd: (anchor) =>
              comments.startComment({ ...anchor, nodeId: params.node.id }),
          }
        : undefined,
    [comments, openThreads, params.node.id],
  );
  if (params.node.kind === "binary" && /\.pdf$/i.test(params.node.name))
    return <SourcePdf node={params.node} />;
  if (params.node.kind === "binary")
    return (
      <div className="space-y-3 p-4 text-sm">
        <p className="text-muted-foreground">
          Preview is not available for this file type.
        </p>
        <Button
          variant="ghost"
          disabled={downloading}
          onClick={async () => {
            setDownloadError("");
            setDownloading(true);
            try {
              const response = await fetch(
                `/api/sources/${workspace.projectId}/${params.node.id}`,
              );
              if (!response.ok) throw new Error("Could not download source");
              downloadFile(await response.blob(), params.node.name);
            } catch {
              setDownloadError(
                "The file could not be downloaded. Try again when online.",
              );
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? "Downloading…" : "Download file"}
        </Button>
        {downloadError && (
          <p role="alert" className="text-destructive">
            {downloadError}
          </p>
        )}
      </div>
    );
  const collaboration = workspace.collaboration.get(params.node.id);
  return (
    <DocumentEditor
      id={params.node.id}
      panelApi={panelApi}
      collaboration={collaboration}
      canWrite={workspace.canWrite}
      filename={params.node.name}
      savedValue={draft?.savedValue ?? ""}
      allowOpenFile={false}
      completion={workspace.completion}
      problems={workspace.problems.get(path) ?? noProblems}
      onSyntaxProblems={(problems) => workspace.reportSyntax(path, problems)}
      onAddReference={workspace.addReference}
      jump={workspace.jump?.id === params.node.id ? workspace.jump : undefined}
      formatSettings={workspace.formatSettings}
      preamble={
        workspace.symbolPreamble && {
          ...workspace.symbolPreamble,
          addPackage: workspace.addSymbolPackage,
        }
      }
      onRevealPdf={
        workspace.synctex
          ? (line) => workspace.revealPdf(path, line)
          : undefined
      }
      onOpenPreview={() => workspace.openMarkdownPreview(params.node.id)}
      comments={editorComments}
    />
  );
}

export function FileTab(
  props: IDockviewPanelHeaderProps<{ preview?: boolean }>,
) {
  const workspace = useWorkspace();
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div />}
        className={cn("h-full", props.params.preview ? "italic" : "not-italic")}
      >
        <DockviewDefaultTab
          {...props}
          onDoubleClick={() => workspace.keepOpen(props.api.id)}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        {props.params.preview && (
          <ContextMenuItem onClick={() => workspace.keepOpen(props.api.id)}>
            Keep open
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={() => workspace.closeTabs(props.api.id, "one")}
        >
          Close
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => workspace.closeTabs(props.api.id, "others")}
        >
          Close others
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => workspace.closeTabs(props.api.id, "all")}
        >
          Close all
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => workspace.closeTabs(props.api.id, "right")}
        >
          Close to the right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const dockComponents = {
  editor: FileEditor,
  generated: GeneratedFile,
  markdown: MarkdownPreview,
  scratchpad: ScratchpadEditor,
  // Restores layouts saved while Problems was a dock tab; the tab is removed.
  problems: () => null,
};
export const dockTabComponents = { file: FileTab };
