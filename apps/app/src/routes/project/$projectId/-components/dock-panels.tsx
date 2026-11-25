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
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { type LatexProblem } from "#/lib/editor/latex/analysis";
import { downloadFile } from "#/lib/storage/browser";
import {
  useWorkspace,
  useWorkspaceActions,
  useWorkspaceBuild,
  useWorkspaceDiagnostics,
} from "#/providers/workspace-provider";

import type { FilePanelParams } from "../-hooks/use-dock-panels";
import { DocumentEditor } from "./document-editor";
import type { EditorComments } from "./editor";
import { GeneratedFile } from "./generated-file";
import { MarkdownPreview } from "./markdown-preview";
import { ScratchpadEditor } from "./scratchpad-editor";
import { SourcePdf } from "./source-pdf";
import type { SymbolPreambleSource } from "./symbol-palette";

const noProblems: LatexProblem[] = [];

export function FileEditor({
  params,
  api: panelApi,
}: IDockviewPanelProps<FilePanelParams>) {
  const actions = useWorkspaceActions();
  const workspace = useWorkspace();
  const { synctex } = useWorkspaceBuild();
  const { problems } = useWorkspaceDiagnostics();
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const { projectId, drafts } = actions;
  const nodeId = params.node.id;
  const savedValue = useSyncExternalStore(
    drafts.subscribe,
    () => drafts.get(nodeId)?.savedValue ?? "",
  );
  const path = workspace.paths.get(nodeId) ?? params.node.name;
  const { comments, main } = workspace;
  const mainLoaded = useSyncExternalStore(
    drafts.subscribe,
    () => !!main && drafts.has(main.id),
  );
  // The palette reads the main file's preamble, also while it is being edited.
  const preamble = useMemo<SymbolPreambleSource | undefined>(
    () =>
      main && mainLoaded
        ? {
            filename: main.path,
            subscribe: drafts.subscribe,
            getSource: () => drafts.get(main.id)?.value ?? "",
            addPackage: actions.addSymbolPackage,
          }
        : undefined,
    [main, mainLoaded, drafts, actions],
  );
  const openPreview = useCallback(
    () => actions.openMarkdownPreview(nodeId),
    [actions, nodeId],
  );
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
                `/api/sources/${projectId}/${nodeId}`,
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
      savedValue={savedValue}
      allowOpenFile={false}
      completion={workspace.completion}
      problems={problems.get(path) ?? noProblems}
      onSyntaxProblems={(problems) => actions.reportSyntax(path, problems)}
      onAddReference={actions.addReference}
      jump={workspace.jump?.id === params.node.id ? workspace.jump : undefined}
      formatSettings={workspace.formatSettings}
      preamble={preamble}
      onRevealPdf={
        synctex ? (line) => actions.revealPdf(path, line) : undefined
      }
      onOpenPreview={openPreview}
      comments={editorComments}
    />
  );
}

export function FileTab(
  props: IDockviewPanelHeaderProps<{ preview?: boolean }>,
) {
  const { keepOpen, closeTabs } = useWorkspaceActions();
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div />}
        className={cn("h-full", props.params.preview ? "italic" : "not-italic")}
      >
        <DockviewDefaultTab
          {...props}
          onDoubleClick={() => keepOpen(props.api.id)}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        {props.params.preview && (
          <ContextMenuItem onClick={() => keepOpen(props.api.id)}>
            Keep open
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => closeTabs(props.api.id, "one")}>
          Close
        </ContextMenuItem>
        <ContextMenuItem onClick={() => closeTabs(props.api.id, "others")}>
          Close others
        </ContextMenuItem>
        <ContextMenuItem onClick={() => closeTabs(props.api.id, "all")}>
          Close all
        </ContextMenuItem>
        <ContextMenuItem onClick={() => closeTabs(props.api.id, "right")}>
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
