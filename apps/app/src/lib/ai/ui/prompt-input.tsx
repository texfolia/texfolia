import { InputGroup, InputGroupTextarea } from "@texfolia/ui/input-group";
import { cn } from "cn";
import {
  type ComponentProps,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { fuzzyFilter } from "#/lib/fuzzy";

import { fileMention, mentionBefore } from "../editor";

const maxFiles = 8;

/** The message being written. Typing @ completes the project's file paths. */
export function PromptInput({
  value,
  files,
  onValueChange,
  inputRef,
  ...props
}: Omit<
  ComponentProps<typeof InputGroupTextarea>,
  "value" | "onChange" | "ref"
> & {
  value: string;
  files: readonly string[];
  onValueChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const id = useId();
  // Null while nothing is selected, or after Escape.
  const [cursor, setCursor] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const placeCursor = useRef<number>(null);
  const mention = useMemo(
    () => (cursor === null ? null : mentionBefore(value.slice(0, cursor))),
    [value, cursor],
  );
  const matches = useMemo(
    () =>
      mention
        ? fuzzyFilter(mention.query, files, (path) => path).slice(0, maxFiles)
        : [],
    [mention, files],
  );
  const open = matches.length > 0;
  const selected = Math.min(active, matches.length - 1);
  useEffect(() => {
    if (placeCursor.current === null) return;
    inputRef.current?.setSelectionRange(
      placeCursor.current,
      placeCursor.current,
    );
    placeCursor.current = null;
  }, [value, inputRef]);

  function choose(path: string) {
    if (!mention || cursor === null) return;
    const inserted = `${fileMention(path)} `;
    placeCursor.current = mention.from + inserted.length;
    onValueChange(
      value.slice(0, mention.from) + inserted + value.slice(cursor),
    );
    setCursor(null);
    inputRef.current?.focus();
  }
  function track(element: HTMLTextAreaElement) {
    const { selectionStart, selectionEnd } = element;
    setCursor(selectionStart === selectionEnd ? selectionStart : null);
  }
  return (
    <div className="relative">
      {open && (
        <ul
          id={`${id}-files`}
          role="listbox"
          aria-label="Project files"
          className="bg-popover text-popover-foreground ring-foreground/10 absolute inset-x-0 bottom-full z-50 mb-1 max-h-56 overflow-y-auto rounded-lg p-1 text-xs shadow-md ring-1"
        >
          {matches.map(({ item }, index) => (
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- The textarea handles the keyboard.
            <li
              key={item}
              id={`${id}-file-${index}`}
              role="option"
              aria-selected={index === selected}
              className={cn(
                "cursor-default truncate rounded-md px-2 py-1",
                index === selected && "bg-accent text-accent-foreground",
              )}
              // The textarea keeps focus.
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(item)}
            >
              {item}
            </li>
          ))}
        </ul>
      )}
      <InputGroup>
        <InputGroupTextarea
          {...props}
          ref={inputRef}
          value={value}
          aria-autocomplete="list"
          aria-controls={open ? `${id}-files` : undefined}
          aria-activedescendant={open ? `${id}-file-${selected}` : undefined}
          onChange={(event) => {
            onValueChange(event.target.value);
            setActive(0);
            track(event.target);
          }}
          onSelect={(event) => track(event.currentTarget)}
          onBlur={() => setCursor(null)}
          onKeyDown={(event) => {
            if (!open || event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((selected + step + matches.length) % matches.length);
            } else if (event.key === "Enter" || event.key === "Tab") {
              const match = matches[selected];
              if (!match) return;
              event.preventDefault();
              choose(match.item);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setCursor(null);
            }
          }}
          className="max-h-40 min-h-24 p-3"
        />
      </InputGroup>
    </div>
  );
}
