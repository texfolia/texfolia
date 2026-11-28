import { EditorView } from "@uiw/react-codemirror";

/** The first visible line, and how far its top sits above the viewport. */
export type ScrollAnchor = { pos: number; margin: number };

/** Selection and scroll position, as document offsets. */
export type EditorSnapshot = {
  anchor: number;
  head: number;
  scroll?: ScrollAnchor;
};

export type EditorJump = {
  line: number;
  column?: number;
  length?: number;
  // Scrolls to this range without moving the selection or focus.
  range?: { from: number; to: number };
};

export function jumpTo(view: EditorView, jump: EditorJump) {
  if (jump.range) {
    const from = Math.min(jump.range.from, view.state.doc.length);
    view.dispatch({
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    return;
  }
  const line = view.state.doc.line(Math.min(jump.line, view.state.doc.lines));
  const anchor = line.from + Math.min((jump.column ?? 1) - 1, line.length);
  view.dispatch({
    selection: {
      anchor,
      head: Math.min(anchor + (jump.length ?? 0), line.to),
    },
    scrollIntoView: true,
  });
  view.focus();
}

export function restoreSnapshot(
  view: EditorView,
  { anchor, head, scroll }: EditorSnapshot,
) {
  const clamp = (position: number) =>
    Math.min(Math.max(position, 0), view.state.doc.length);
  view.dispatch({
    selection: { anchor: clamp(anchor), head: clamp(head) },
    effects: scroll
      ? EditorView.scrollIntoView(clamp(scroll.pos), {
          y: "start",
          yMargin: scroll.margin,
        })
      : undefined,
    scrollIntoView: !scroll,
  });
}
