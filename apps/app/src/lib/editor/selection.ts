import type { EditorState } from "@uiw/react-codemirror";

/** The selected text and its lines, or the cursor's line without a selection. */
export function selectedLines(state: EditorState) {
  const { main } = state.selection;
  const { from, to } = main.empty ? state.doc.lineAt(main.head) : main;
  // A selection that ends at the start of a line does not include that line.
  const end = to > from && state.doc.lineAt(to).from === to ? to - 1 : to;
  return {
    text: state.sliceDoc(from, to),
    from: state.doc.lineAt(from).number,
    to: state.doc.lineAt(end).number,
  };
}
