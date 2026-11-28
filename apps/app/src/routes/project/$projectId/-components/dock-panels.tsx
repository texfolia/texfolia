import { type LatexProblem } from "@texfolia/editor";
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

import { BinaryPreview } from "#/components/binary-preview";
import { lazyPanel } from "#/components/lazy-panel";
import { problemPrompt, selectionPrompt } from "#/lib/ai/editor";
import type { ProjectNode } from "#/lib/projects/project.functions";
import { downloadFile } from "#/lib/storage/browser";
import { useProjectFiles } from "#/providers/project-files-provider";
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
import type { MarkdownPreviewParams } from "./markdown-preview";
import { ScratchpadEditor } from "./scratchpad-editor";
import type { SymbolPreambleSource } from "./symbol-palette";

const MarkdownPreview = lazyPanel<IDockviewPanelProps<MarkdownPreviewParams>>(
  "The Markdown preview",
  async () => {
    const { MarkdownPreview } = await import("./markdown-preview");
    return MarkdownPreview;
  },
);

const noProblems: LatexProblem[] = [];

export function FileEditor({
  params,
  api: panelApi,
}: IDockviewPanelProps<FilePanelParams>) {
  const actions = useWorkspaceActions();
  const workspace = useWorkspace();
  const { synctex } = useWorkspaceBuild();
  const { problems } = useWorkspaceDiagnostics();
  const { drafts } = actions;
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
            onAdd: comments.data?.canComment
              ? (anchor) =>
                  comments.startComment({ ...anchor, nodeId: params.node.id })
              : undefined,
          }
        : undefined,
    [comments, openThreads, params.node.id],
  );
  if (params.node.kind === "binary") return <BinaryFile node={params.node} />;
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
      onAskAi={(selection) => actions.askAi(selectionPrompt(path, selection))}
      onFixWithAi={(problem) =>
        actions.askAi(problemPrompt({ path, ...problem }))
      }
      onUploadImages={actions.uploadImages}
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

function BinaryFile({ node }: { node: ProjectNode }) {
  const { projectId } = useWorkspaceActions();
  const files = useProjectFiles();
  const version = useSyncExternalStore(
    files.subscribe,
    () => files.sourceVersions[node.id]?.objectKey,
  );
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const url = `/api/sources/${projectId}/${node.id}`;
  async function download() {
    setError("");
    setDownloading(true);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not download source");
      downloadFile(await response.blob(), node.name);
    } catch {
      setError("The file could not be downloaded. Try again when online.");
    } finally {
      setDownloading(false);
    }
  }
  return (
    <BinaryPreview
      url={url}
      name={node.name}
      version={version ?? undefined}
      fallback={
        <div className="space-y-3 p-4 text-sm">
          <p className="text-muted-foreground">
            Preview is not available for this file type.
          </p>
          <Button
            variant="ghost"
            disabled={downloading}
            onClick={() => void download()}
          >
            {downloading ? "Downloading…" : "Download file"}
          </Button>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
      }
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
