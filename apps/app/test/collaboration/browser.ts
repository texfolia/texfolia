import { formatChanges } from "@texfolia/editor/latex/format";
import { EditorState, EditorView, keymap } from "@uiw/react-codemirror";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

import { CollaborativeFile } from "../../src/lib/collaboration/file";

const parameters = new URLSearchParams(location.search);
const file = new CollaborativeFile({
  projectId: parameters.get("projectId") ?? "",
  nodeId: parameters.get("nodeId") ?? "",
  userId: parameters.get("userId") ?? "",
  canWrite: parameters.get("viewer") !== "1",
  onChange: () => {},
});
let view: EditorView | undefined;
let undoManager: Y.UndoManager | undefined;
let updatedAt = 0;
file.subscribe(() => {
  if (!file.getStatus().ready || view) return;
  undoManager = new Y.UndoManager(file.text);
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: file.text.toString(),
      extensions: [
        EditorView.updateListener.of((update) => {
          if (update.docChanged) updatedAt = Date.now();
        }),
        yCollab(file.text, file.awareness, { undoManager }),
        keymap.of(yUndoManagerKeymap),
        EditorState.readOnly.of(parameters.get("viewer") === "1"),
        EditorView.editable.of(parameters.get("viewer") !== "1"),
      ],
    }),
  });
});

const api = {
  value: () => file.text.toString(),
  editorValue: () => view?.state.doc.toString(),
  status: () => file.getStatus(),
  insert: (at: number, text: string) => {
    const startedAt = Date.now();
    view?.dispatch({ changes: { from: at, insert: text } });
    return startedAt;
  },
  updatedAt: () => updatedAt,
  replace: (text: string) => file.replace(text),
  format: (text: string) =>
    view?.dispatch({ changes: formatChanges(view.state.doc.toString(), text) }),
  select: (anchor: number, head = anchor) => {
    view?.focus();
    view?.dispatch({ selection: { anchor, head } });
  },
  presence: () =>
    [...file.awareness.getStates()].map(([id, state]) => ({
      id,
      userName: typeof state.user?.name === "string" ? state.user.name : "",
    })),
  cursorIndex: (clientId: number) => {
    const state = file.awareness.getStates().get(clientId);
    return state?.cursor
      ? Y.createAbsolutePositionFromRelativePosition(
          state.cursor.anchor,
          file.doc,
        )?.index
      : undefined;
  },
  clientId: () => file.doc.clientID,
  save: () => file.save(),
  undo: () => undoManager?.undo(),
  maliciousUpdate: () => {
    const socket = new WebSocket(
      `${location.origin.replace("http", "ws")}/api/collaboration/${parameters.get("projectId")}/${parameters.get("nodeId")}?clientId=${file.doc.clientID}`,
    );
    return new Promise<string>((resolve, reject) => {
      socket.onopen = () => {
        const doc = new Y.Doc();
        doc.getText("source").insert(0, "FORBIDDEN");
        const bytes = Y.encodeStateAsUpdate(doc);
        socket.send(
          JSON.stringify({
            type: "update",
            update: btoa(String.fromCharCode(...bytes)),
          }),
        );
        doc.destroy();
      };
      socket.onmessage = (event) => {
        socket.close();
        resolve(event.data);
      };
      socket.onerror = reject;
    });
  },
};
Object.assign(window, { collaborationTest: api });
export type BrowserApi = typeof api;
