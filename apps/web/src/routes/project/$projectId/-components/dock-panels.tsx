import type { EditorView } from "@uiw/react-codemirror";
import { cn } from "cn";
import {
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as Y from "yjs";

import { Button } from "#/components/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "#/components/ui/context-menu";
import { downloadFile } from "#/lib/download-file";
import { type LatexProblem } from "#/lib/latex/analysis";
import { useWorkspace, type Workspace } from "#/providers/workspace-provider";

import type { FilePanelParams } from "../-hooks/use-dock-panels";
import { Editor, type EditorComments, type EditorSnapshot } from "./editor";
import { GeneratedFile } from "./generated-file";
import { MarkdownPreview } from "./markdown-preview";
import { SourcePdf } from "./source-pdf";

const noProblems: LatexProblem[] = [];
const emptySubscribe = () => () => {};
const noCollaborationStatus = () => undefined;

export function FileEditor({
  params,
  api: panelApi,
}: IDockviewPanelProps<FilePanelParams>) {
  const workspace = useWorkspace();
  const editor = useRef<EditorView | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const { registerEditor } = workspace;
  useEffect(() => {
    if (editor.current) registerEditor(params.node.id, editor.current);
    return () => registerEditor(params.node.id, null);
  }, [params.node.id, registerEditor]);
  // Hidden tabs unmount their editor; dockview keeps the panel itself mounted.
  const subscribeVisibility = useCallback(
    (notify: () => void) => {
      const subscription = panelApi.onDidVisibilityChange(notify);
      return () => subscription.dispose();
    },
    [panelApi],
  );
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => panelApi.isVisible,
  );
  // Selection and scroll kept as relative positions so edits made while the
  // tab is hidden don't shift them.
  const snapshot = useRef<{
    anchor: Y.RelativePosition;
    head: Y.RelativePosition;
    scroll?: { pos: Y.RelativePosition; margin: number };
  }>(null);
  // The jump the last editor already applied, so a remount doesn't repeat it.
  const appliedJump = useRef<Workspace["jump"]>(undefined);
  useEffect(() => {
    let frame = 0;
    const subscription = panelApi.onDidActiveChange(({ isActive }) => {
      cancelAnimationFrame(frame);
      if (isActive)
        frame = requestAnimationFrame(() => editor.current?.focus());
    });
    return () => {
      cancelAnimationFrame(frame);
      subscription.dispose();
    };
  }, [panelApi]);
  const collaboration = workspace.collaboration.get(params.node.id);
  const status = useSyncExternalStore(
    collaboration?.subscribe ?? emptySubscribe,
    collaboration?.getStatus ?? noCollaborationStatus,
  );
  const initialSnapshot = useMemo<EditorSnapshot | undefined>(() => {
    const saved = snapshot.current;
    if (!visible || !saved || !collaboration) return undefined;
    const absolute = (position: Y.RelativePosition) =>
      Y.createAbsolutePositionFromRelativePosition(position, collaboration.doc)
        ?.index ?? 0;
    return {
      anchor: absolute(saved.anchor),
      head: absolute(saved.head),
      scroll: saved.scroll && {
        pos: absolute(saved.scroll.pos),
        margin: saved.scroll.margin,
      },
    };
  }, [visible, collaboration]);
  const jump =
    workspace.jump?.id === params.node.id &&
    workspace.jump !== appliedJump.current
      ? workspace.jump
      : undefined;
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
  if (!collaboration || !status?.ready)
    return (
      <p role="status" className="p-4 text-sm">
        {status?.error || "Connecting to collaboration…"}
      </p>
    );
  if (!visible) return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {(!status.connected || status.error) && (
        <p role="status" className="border-b px-3 py-2 text-xs">
          {status.error || "Offline. Edits will merge when reconnected."}
        </p>
      )}
      <Editor
        onCommands={(run) => workspace.registerCommands(params.node.id, run)}
        onCursorPosition={(position) =>
          workspace.reportCursor(params.node.id, position)
        }
        collaboration={collaboration}
        key={params.node.id}
        readOnly={!workspace.canWrite || !status.canWrite}
        onCreateEditor={(view) => {
          editor.current = view;
          registerEditor(params.node.id, view);
          if (panelApi.isActive) view.focus();
        }}
        filename={params.node.name}
        defaultValue={collaboration.text.toString()}
        savedValue={draft?.savedValue ?? ""}
        allowOpenFile={false}
        completion={workspace.completion}
        problems={workspace.problems.get(path) ?? noProblems}
        onSyntaxProblems={(problems) => workspace.reportSyntax(path, problems)}
        jump={jump}
        initialSnapshot={initialSnapshot}
        onSnapshot={({ anchor, head, scroll }) => {
          const relative = (index: number) =>
            Y.createRelativePositionFromTypeIndex(collaboration.text, index);
          snapshot.current = {
            anchor: relative(anchor),
            head: relative(head),
            scroll: scroll && {
              pos: relative(scroll.pos),
              margin: scroll.margin,
            },
          };
          if (jump) appliedJump.current = jump;
          editor.current = null;
          registerEditor(params.node.id, null);
        }}
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
    </div>
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
  // Restores layouts saved while Problems was a dock tab; the tab is removed.
  problems: () => null,
};
export const dockTabComponents = { file: FileTab };
