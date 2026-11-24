import { redo, undo } from "@codemirror/commands";
import { EditorView, Facet, Prec, type Extension } from "@uiw/react-codemirror";

import type { EditorKeymap } from "./keymaps";

/**
 * Undo and redo for the modal keymaps. The packages call CodeMirror's history
 * commands, which do nothing in collaborative editors whose history is a Yjs
 * undo manager, so the editor provides its own.
 */
export type KeymapHistory = {
  undo: (view: EditorView) => unknown;
  redo: (view: EditorView) => unknown;
};
export const keymapHistory = Facet.define<
  KeymapHistory,
  KeymapHistory | undefined
>({ combine: (values) => values[0] });

const loaded = new Map<Exclude<EditorKeymap, "default">, Extension>();
const pending = new Map<Exclude<EditorKeymap, "default">, Promise<Extension>>();
const loaders: Record<
  Exclude<EditorKeymap, "default">,
  () => Promise<Extension>
> = {
  async vim() {
    const { vim, CodeMirror } = await import("@replit/codemirror-vim");
    const { commands } = CodeMirror;
    for (const name of ["undo", "redo"] as const) {
      const fallback = commands[name];
      commands[name] = (cm) => {
        const history = cm.cm6.state.facet(keymapHistory);
        if (history) history[name](cm.cm6);
        else fallback(cm);
      };
    }
    return vim({ status: true });
  },
  async emacs() {
    const { emacs, EmacsHandler } = await import("@replit/codemirror-emacs");
    const run = (name: "undo" | "redo") => (view: EditorView) => {
      const history = view.state.facet(keymapHistory);
      return history
        ? history[name](view)
        : (name === "undo" ? undo : redo)(view);
    };
    EmacsHandler.bindKey("C-/|C-x u|S-C--|C-z", run("undo"));
    EmacsHandler.bindKey("S-C-/|S-C-x u|C--|S-C-z", run("redo"));
    return emacs();
  },
};

/** The keymap's extension if it has loaded, otherwise undefined. */
export function loadedKeymapExtension(
  keymap: EditorKeymap,
): Extension | undefined {
  return keymap === "default" ? [] : loaded.get(keymap);
}

/**
 * Loads a keymap's package on first use. The extension has the highest
 * precedence, as both packages require, so it sees keys before other keymaps.
 */
export function loadKeymapExtension(keymap: EditorKeymap): Promise<Extension> {
  if (keymap === "default") return Promise.resolve([]);
  const ready = loaded.get(keymap);
  if (ready) return Promise.resolve(ready);
  let request = pending.get(keymap);
  if (!request) {
    request = loaders[keymap]().then(
      (extension) => {
        const wrapped = [
          Prec.highest(extension),
          // The app gives the keymap its keys only in editors marked with it.
          EditorView.editorAttributes.of({ "data-keymap": keymap }),
        ];
        loaded.set(keymap, wrapped);
        pending.delete(keymap);
        return wrapped;
      },
      (error: unknown) => {
        // Allow a retry after a failed chunk request.
        pending.delete(keymap);
        throw error;
      },
    );
    pending.set(keymap, request);
  }
  return request;
}
