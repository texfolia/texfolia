import {
  Decoration,
  type DecorationSet,
  type EditorState,
  EditorView,
  gutter,
  GutterMarker,
  RangeSet,
  StateEffect,
  StateField,
} from "@uiw/react-codemirror";

export type CommentRange = { id: string; from: number; to: number };

type State = {
  ranges: CommentRange[];
  activeId: string | undefined;
  decorations: DecorationSet;
};

// Replaces every comment range in the editor. Ranges then follow local and
// remote edits through ordinary change mapping until the next replacement.
export const setCommentRanges = StateEffect.define<{
  ranges: CommentRange[];
  activeId: string | undefined;
}>();

const rangeMark = Decoration.mark({ class: "cm-comment-range" });
const activeMark = Decoration.mark({
  class: "cm-comment-range cm-comment-range-active",
});

function decorate(ranges: CommentRange[], activeId: string | undefined) {
  return Decoration.set(
    ranges
      .filter((range) => range.to > range.from)
      .map((range) =>
        (range.id === activeId ? activeMark : rangeMark).range(
          range.from,
          range.to,
        ),
      ),
    true,
  );
}

const commentState = StateField.define<State>({
  create: () => ({
    ranges: [],
    activeId: undefined,
    decorations: Decoration.none,
  }),
  update(state, transaction) {
    let next = state;
    if (transaction.docChanged)
      next = {
        ...next,
        ranges: next.ranges.map((range) => {
          const from = transaction.changes.mapPos(range.from, 1);
          return {
            ...range,
            from,
            to: Math.max(from, transaction.changes.mapPos(range.to, -1)),
          };
        }),
        decorations: next.decorations.map(transaction.changes),
      };
    for (const effect of transaction.effects)
      if (effect.is(setCommentRanges)) {
        const length = transaction.newDoc.length;
        const ranges = effect.value.ranges.map((range) => ({
          ...range,
          from: Math.min(range.from, length),
          to: Math.min(range.to, length),
        }));
        next = {
          ranges,
          activeId: effect.value.activeId,
          decorations: decorate(ranges, effect.value.activeId),
        };
      }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (state) => state.decorations),
});

class CommentMarker extends GutterMarker {
  constructor(
    readonly ids: string[],
    readonly active: boolean,
  ) {
    super();
  }
  override eq(other: CommentMarker) {
    return other.active === this.active && other.ids.join() === this.ids.join();
  }
  override toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = this.active
      ? "cm-comment-marker cm-comment-marker-active"
      : "cm-comment-marker";
    button.dataset.threadId = this.ids[0];
    const label =
      this.ids.length === 1
        ? "Show comment"
        : `Show ${this.ids.length} comments`;
    button.title = label;
    button.setAttribute("aria-label", label);
    // A speech bubble, matching the Comments view icon.
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/></svg>';
    return button;
  }
}

function markers(view: EditorView) {
  const { ranges, activeId } = view.state.field(commentState);
  const lines = new Map<number, string[]>();
  for (const range of ranges) {
    const line = view.state.doc.lineAt(range.from).from;
    const ids = lines.get(line);
    if (ids) ids.push(range.id);
    else lines.set(line, [range.id]);
  }
  return RangeSet.of(
    [...lines]
      .sort(([a], [b]) => a - b)
      .map(([line, ids]) => {
        // The active thread opens first when its line is clicked again.
        const ordered =
          activeId && ids.includes(activeId)
            ? [activeId, ...ids.filter((id) => id !== activeId)]
            : ids;
        return new CommentMarker(
          ordered,
          activeId !== undefined && ids.includes(activeId),
        ).range(line);
      }),
  );
}

// The comment ranges currently shown in an editor state.
export function commentRangesOf(state: EditorState) {
  return state.field(commentState, false)?.ranges ?? [];
}

export function commentRanges(onSelect: (id: string) => void) {
  return [
    commentState,
    gutter({
      class: "cm-comment-gutter",
      markers,
      initialSpacer: () => new CommentMarker([], false),
      domEventHandlers: {
        mousedown(view, line) {
          const ids = view.state
            .field(commentState)
            .ranges.filter(
              (range) => view.state.doc.lineAt(range.from).from === line.from,
            )
            .map((range) => range.id);
          if (!ids.length) return false;
          const { activeId } = view.state.field(commentState);
          // Clicking a line with several threads cycles through them.
          const index = activeId ? ids.indexOf(activeId) : -1;
          onSelect(ids[(index + 1) % ids.length] ?? ids[0]!);
          return true;
        },
      },
    }),
    EditorView.theme({
      ".cm-comment-gutter": { width: "18px" },
      ".cm-comment-gutter .cm-gutterElement": {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
      },
      ".cm-comment-marker": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: "1.4em",
        padding: "0",
        border: "0",
        background: "transparent",
        color: "var(--muted-foreground)",
        cursor: "pointer",
      },
      ".cm-comment-marker-active, .cm-comment-marker:hover": {
        color: "var(--primary)",
      },
      ".cm-comment-range": {
        backgroundColor: "rgb(245 158 11 / 0.2)",
        borderBottom: "2px solid rgb(245 158 11 / 0.6)",
      },
      ".cm-comment-range-active": {
        backgroundColor: "rgb(245 158 11 / 0.4)",
      },
    }),
  ];
}
