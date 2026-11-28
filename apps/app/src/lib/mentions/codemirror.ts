import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type Extension,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@uiw/react-codemirror";

import { fuzzyFilter } from "#/lib/fuzzy";

import {
  formatMentionToken,
  mentionQueryBefore,
  type MentionCandidate,
  type ResolvedMention,
} from "./tokens";

class MentionChipWidget extends WidgetType {
  constructor(
    readonly userId: string,
    readonly displayName: string,
    readonly status: ResolvedMention["status"],
  ) {
    super();
  }

  override eq(other: MentionChipWidget) {
    return (
      other.userId === this.userId &&
      other.displayName === this.displayName &&
      other.status === this.status
    );
  }

  override toDOM() {
    const span = document.createElement("span");
    span.dataset.mentionId = this.userId;
    span.dataset.mentionStatus = this.status;
    span.className =
      this.status === "active"
        ? "bg-primary/12 text-primary inline-flex items-center rounded-sm px-1 py-0.5 align-baseline font-sans text-[0.92em] font-medium leading-tight"
        : "bg-muted text-muted-foreground inline-flex items-center rounded-sm px-1 py-0.5 align-baseline font-sans text-[0.92em] font-medium leading-tight";
    span.textContent = `@${this.displayName}`;
    if (this.status === "former")
      span.title = "No longer has access to this project";
    else if (this.status === "deleted") span.title = "Account deleted";
    return span;
  }

  override ignoreEvent() {
    return false;
  }
}

/**
 * CodeMirror extension for `@`-mentions of people in the project scratchpad:
 * - Typing `@` opens an autocomplete list of project-accessible people
 * - Inserts structured `@[Name](mention:<userId>) ` tokens
 * - Renders structured tokens as atomic inline chips while editing
 */
export function scratchpadMentionExtension({
  getCandidates,
  getResolved,
}: {
  getCandidates: () => readonly MentionCandidate[];
  getResolved: (userId: string) => ResolvedMention | undefined;
}): Extension {
  const completionSource = (
    context: CompletionContext,
  ): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const match = mentionQueryBefore(before);
    if (!match) return null;
    const candidates = getCandidates();
    if (!candidates.length) return null;
    const filtered = fuzzyFilter(
      match.query,
      candidates,
      (person) => person.name,
    );
    if (!filtered.length) return null;
    const options: Completion[] = filtered.map(({ item }) => ({
      label: item.name,
      type: "person",
      apply: (view, _completion, from, to) => {
        const inserted = `${formatMentionToken(item)} `;
        view.dispatch({
          changes: { from, to, insert: inserted },
          selection: { anchor: from + inserted.length },
        });
      },
    }));
    return {
      from: line.from + match.from,
      options,
      filter: false,
    };
  };

  const decorator = new MatchDecorator({
    regexp: /@\[([^\]\r\n]+)\]\(mention:([A-Za-z0-9_-]{1,128})\)/g,
    decoration: (match) => {
      const fallbackName = match[1] ?? "User";
      const userId = match[2] ?? "";
      const resolved = getResolved(userId);
      const displayName = resolved?.name ?? fallbackName;
      const status = resolved?.status ?? "active";
      return Decoration.replace({
        widget: new MentionChipWidget(userId, displayName, status),
      });
    },
  });

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(update: ViewUpdate) {
        this.decorations = decorator.updateDeco(update, this.decorations);
      }
    },
    {
      decorations: (instance) => instance.decorations,
      provide: (viewPlugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(viewPlugin)?.decorations ?? Decoration.none,
        ),
    },
  );

  return [
    plugin,
    autocompletion({
      override: [completionSource],
      activateOnTyping: true,
    }),
  ];
}
