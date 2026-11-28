import { Avatar, AvatarFallback, AvatarImage } from "@texfolia/ui/avatar";
import { cn } from "cn";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { fuzzyFilter } from "#/lib/fuzzy";
import {
  formatMentionToken,
  mentionQueryBefore,
  parseMentions,
  type MentionCandidate,
} from "#/lib/mentions/tokens";

const maxSuggestions = 8;

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
}

function createChipElement(userId: string, displayName: string) {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.mentionId = userId;
  chip.dataset.mentionName = displayName;
  chip.className =
    "bg-primary/12 text-primary mx-0.5 inline-flex items-center rounded-sm px-1 py-0.5 align-baseline font-medium leading-tight select-none";
  chip.textContent = `@${displayName}`;
  return chip;
}

/** Serializes the contentEditable DOM back to canonical `@[Name](mention:id)` text. */
function serializeElement(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replaceAll("\u00a0", " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const mentionId = el.dataset.mentionId;
    if (mentionId) {
      out += formatMentionToken({
        id: mentionId,
        name:
          el.dataset.mentionName ?? el.textContent?.replace(/^@/, "") ?? "User",
      });
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    const isBlock = el.tagName === "DIV" || el.tagName === "P";
    if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
    for (const child of el.childNodes) walk(child);
  };
  for (const child of root.childNodes) walk(child);
  // Browsers often append a trailing <br> in empty/multiline contentEditable.
  return out.replace(/\n$/, "");
}

/** Populates the contentEditable DOM from canonical `@[Name](mention:id)` text. */
function hydrateElement(
  root: HTMLElement,
  value: string,
  candidates: readonly MentionCandidate[],
) {
  const byId = new Map(candidates.map((person) => [person.id, person]));
  root.replaceChildren();
  const segments = parseMentions(value);
  for (const segment of segments) {
    if (segment.kind === "text") {
      const lines = segment.text.split("\n");
      lines.forEach((line, index) => {
        if (index > 0) root.appendChild(document.createElement("br"));
        if (line) root.appendChild(document.createTextNode(line));
      });
    } else {
      const name = byId.get(segment.userId)?.name ?? segment.fallbackName;
      root.appendChild(createChipElement(segment.userId, name));
    }
  }
}

/** Reads plain text from the start of the active text node up to the caret. */
function activeQueryInSelection(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !selection.isCollapsed)
    return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;
  const textNode = range.startContainer as Text;
  const before = (textNode.textContent ?? "")
    .slice(0, range.startOffset)
    .replaceAll("\u00a0", " ");
  const query = mentionQueryBefore(before);
  if (!query) return null;
  return {
    textNode,
    from: query.from,
    to: range.startOffset,
    query: query.query,
  };
}

/**
 * Comment composer with `@` people mentions shown as inline chips while editing.
 * Value is stored as canonical `@[Display Name](mention:<userId>)` text.
 */
export function MentionComposer({
  value,
  onValueChange,
  candidates,
  placeholder,
  disabled = false,
  autoFocus = false,
  maxLength,
  ariaLabel,
  className,
  onSubmit,
  onCancel,
  onFocus,
}: {
  value: string;
  onValueChange: (next: string) => void;
  candidates: readonly MentionCandidate[];
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  ariaLabel: string;
  className?: string;
  onSubmit?: () => void;
  onCancel?: () => void;
  onFocus?: () => void;
}) {
  const id = useId();
  const editorRef = useRef<HTMLDivElement>(null);
  const lastValueRef = useRef<string | null>(null);
  const mentionNodeRef = useRef<Text | null>(null);
  const [mentionState, setMentionState] = useState<{
    from: number;
    to: number;
    query: string;
  } | null>(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(
    () =>
      mentionState
        ? fuzzyFilter(
            mentionState.query,
            candidates,
            (person) => person.name,
          ).slice(0, maxSuggestions)
        : [],
    [mentionState, candidates],
  );
  const open = mentionState !== null && matches.length > 0;
  const selected = Math.min(active, Math.max(0, matches.length - 1));

  // Sync external value changes (e.g. initial edit state or clearing on submit).
  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    if (lastValueRef.current === value) return;
    hydrateElement(root, value, candidates);
    lastValueRef.current = value;
  }, [value, candidates]);

  useEffect(() => {
    if (!autoFocus) return;
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [autoFocus]);

  function emitChange() {
    const root = editorRef.current;
    if (!root) return;
    let next = serializeElement(root);
    if (maxLength !== undefined && next.length > maxLength) {
      next = next.slice(0, maxLength);
      hydrateElement(root, next, candidates);
    }
    lastValueRef.current = next;
    onValueChange(next);
  }

  function refreshQuery() {
    const root = editorRef.current;
    if (!root || disabled) {
      mentionNodeRef.current = null;
      setMentionState(null);
      return;
    }
    const next = activeQueryInSelection(root);
    if (!next) {
      mentionNodeRef.current = null;
      setMentionState(null);
      return;
    }
    mentionNodeRef.current = next.textNode;
    setMentionState({ from: next.from, to: next.to, query: next.query });
    setActive(0);
  }

  function insertMention(person: MentionCandidate) {
    const root = editorRef.current;
    const textNode = mentionNodeRef.current;
    if (!root || !mentionState || !textNode) return;
    const { from, to } = mentionState;
    if (!root.contains(textNode)) {
      mentionNodeRef.current = null;
      setMentionState(null);
      return;
    }
    const raw = textNode.textContent ?? "";
    const before = raw.slice(0, from);
    const after = raw.slice(to);
    const parent = textNode.parentNode;
    if (!parent) return;

    const chip = createChipElement(person.id, person.name);
    const trailing = document.createTextNode(
      after.startsWith(" ") ? after : ` ${after}`,
    );

    if (before) {
      textNode.textContent = before;
      parent.insertBefore(chip, textNode.nextSibling);
      parent.insertBefore(trailing, chip.nextSibling);
    } else {
      parent.insertBefore(chip, textNode);
      parent.insertBefore(trailing, chip.nextSibling);
      parent.removeChild(textNode);
    }

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.setStart(trailing, 1);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    mentionNodeRef.current = null;
    setMentionState(null);
    emitChange();
    root.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((selected + step + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const match = matches[selected];
        if (!match) return;
        event.preventDefault();
        insertMention(match.item);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMentionState(null);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit) {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    emitChange();
    refreshQuery();
  }

  return (
    <div className="relative">
      {open && (
        <ul
          id={`${id}-mentions`}
          role="listbox"
          aria-label="Mention a person"
          className="bg-popover text-popover-foreground ring-foreground/10 absolute inset-x-0 bottom-full z-50 mb-1 max-h-56 overflow-y-auto rounded-lg p-1 text-xs shadow-md ring-1"
        >
          {matches.map(({ item }, index) => (
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- The editor handles the keyboard.
            <li
              key={item.id}
              id={`${id}-mention-${index}`}
              role="option"
              aria-selected={index === selected}
              className={cn(
                "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5",
                index === selected && "bg-accent text-accent-foreground",
              )}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(index)}
              onClick={() => insertMention(item)}
            >
              <Avatar size="sm" className="size-5 shrink-0">
                {item.image && <AvatarImage src={item.image} alt="" />}
                <AvatarFallback className="text-[9px]">
                  {initialsOf(item.name)}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 truncate">{item.name}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        {!value && placeholder && (
          <span
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 text-xs select-none"
          >
            {placeholder}
          </span>
        )}
        <div
          ref={editorRef}
          role="textbox"
          tabIndex={disabled ? -1 : 0}
          aria-multiline="true"
          aria-label={ariaLabel}
          aria-disabled={disabled || undefined}
          aria-autocomplete="list"
          aria-controls={open ? `${id}-mentions` : undefined}
          aria-activedescendant={open ? `${id}-mention-${selected}` : undefined}
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck
          className={cn(
            "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 min-h-16 w-full rounded-lg border bg-transparent px-2.5 py-2 text-xs wrap-anywhere whitespace-pre-wrap transition-colors outline-none focus-visible:ring-3",
            disabled && "pointer-events-none opacity-50",
            className,
          )}
          onInput={() => {
            emitChange();
            refreshQuery();
          }}
          onKeyUp={refreshQuery}
          onClick={refreshQuery}
          onFocus={onFocus}
          onBlur={() => setMentionState(null)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
      </div>
    </div>
  );
}
