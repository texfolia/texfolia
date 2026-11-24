import CodeMirror, { keymap, Prec } from "@uiw/react-codemirror";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

import {
  keymapHistory,
  loadKeymapExtension,
  loadedKeymapExtension,
} from "#/lib/editor/keymaps/extension";
import type { EditorKeymap } from "#/lib/editor/keymaps/keymaps";

import {
  defaultShortcuts,
  type ShortcutAction,
} from "../../src/lib/shortcuts/shortcuts";
import {
  ShortcutsProvider,
  useAppShortcut,
} from "../../src/providers/shortcuts-provider";

// Mirrors the workspace editor's wiring: a Yjs document and undo manager, the
// lazily loaded keymap, and app shortcuts dispatched from the window.
const doc = new Y.Doc();
const text = doc.getText("source");
text.insert(0, "first line\nsecond line\nthird line");
const undoManager = new Y.UndoManager(text);
const runs: ShortcutAction[] = [];
let select: (keymap: EditorKeymap) => void = () => {};
Object.assign(window, {
  keymapTest: {
    takeRuns: () => runs.splice(0),
    text: () => text.toString(),
    select: (keymap: EditorKeymap) => select(keymap),
  },
});

function Shortcut({ action }: { action: ShortcutAction }) {
  useAppShortcut(action, () => runs.push(action));
  return null;
}

function App() {
  const [mode, setMode] = useState<EditorKeymap>("default");
  const [, setLoads] = useState(0);
  const [initial] = useState(() => text.toString());
  select = setMode;
  const loaded = loadedKeymapExtension(mode);
  useEffect(() => {
    if (!loaded)
      void loadKeymapExtension(mode).then(() => setLoads((n) => n + 1));
  }, [mode, loaded]);
  const extensions = useMemo(
    () => [
      loaded ?? [],
      keymapHistory.of({
        undo: () => undoManager.undo(),
        redo: () => undoManager.redo(),
      }),
      yCollab(text, null, { undoManager }),
      Prec.highest(keymap.of(yUndoManagerKeymap)),
    ],
    [loaded],
  );
  return (
    <ShortcutsProvider map={defaultShortcuts} editorKeymap={mode}>
      {(
        [
          "save",
          "saveWithoutCompiling",
          "underline",
          "nextTab",
        ] as ShortcutAction[]
      ).map((action) => (
        <Shortcut key={action} action={action} />
      ))}
      <CodeMirror
        basicSetup={{ history: false }}
        value={initial}
        extensions={extensions}
      />
    </ShortcutsProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
