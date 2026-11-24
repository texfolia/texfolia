import type { EditorView } from "@uiw/react-codemirror";
import type { IDockviewPanelProps } from "dockview-react";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import * as Y from "yjs";

import type { CollaborativeFile } from "#/lib/collaboration/browser";
import { useWorkspace, type Workspace } from "#/providers/workspace-provider";

import { Editor, type EditorSnapshot } from "./editor";

const emptySubscribe = () => () => {};
const noCollaborationStatus = () => undefined;

/**
 * The editor of one collaborative document, in a dock tab. The document stays
 * connected while its tab is open. While another tab hides it, the editor
 * unmounts and its selection and scroll position are kept.
 */
export function DocumentEditor({
  id,
  panelApi,
  collaboration,
  canWrite,
  jump: requestedJump,
  onAddReference,
  ...props
}: Omit<
  ComponentProps<typeof Editor>,
  | "collaboration"
  | "jump"
  | "readOnly"
  | "defaultValue"
  | "initialSnapshot"
  | "onSnapshot"
  | "onCommands"
  | "onCursorPosition"
  | "onCreateEditor"
> & {
  id: string;
  panelApi: IDockviewPanelProps["api"];
  collaboration: CollaborativeFile | undefined;
  canWrite: boolean;
  jump?: Workspace["jump"];
}) {
  const workspace = useWorkspace();
  const editor = useRef<EditorView | null>(null);
  const { registerEditor, holdDocument } = workspace;
  useEffect(() => {
    if (editor.current) registerEditor(id, editor.current);
    return () => registerEditor(id, null);
  }, [id, registerEditor]);
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
  // Open tabs stay connected, including while another tab hides them.
  useEffect(() => holdDocument(id), [holdDocument, id]);
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
    requestedJump !== appliedJump.current ? requestedJump : undefined;
  if (!collaboration || !status?.ready)
    return (
      <p role="status" className="p-4 text-sm">
        {status?.error || "Connecting to collaboration…"}
      </p>
    );
  if (!visible) return null;
  const readOnly = !canWrite || !status.canWrite;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {(!status.connected || status.error) && (
        <p role="status" className="border-b px-3 py-2 text-xs">
          {status.error || "Offline. Edits will merge when reconnected."}
        </p>
      )}
      <Editor
        {...props}
        onCommands={(run) => workspace.registerCommands(id, run)}
        onCursorPosition={(position) => workspace.reportCursor(id, position)}
        collaboration={collaboration}
        key={id}
        readOnly={readOnly}
        onAddReference={readOnly ? undefined : onAddReference}
        onCreateEditor={(view) => {
          editor.current = view;
          registerEditor(id, view);
          if (panelApi.isActive) view.focus();
        }}
        defaultValue={collaboration.text.toString()}
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
          registerEditor(id, null);
        }}
      />
    </div>
  );
}
