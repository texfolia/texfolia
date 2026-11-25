import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@texfolia/ui/dialog";
import { Input } from "@texfolia/ui/input";
import { Kbd } from "@texfolia/ui/kbd";
import { cn } from "cn";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { fuzzyFilter } from "#/lib/fuzzy";
import {
  bindingLabel,
  eventChord,
  isMac,
  type ShortcutAction,
} from "#/lib/shortcuts/shortcuts";
import { parseFileQuery } from "#/lib/workspace/file-query";
import { useSettings } from "#/providers/settings-provider";

export type PaletteMode = "files" | "commands";
export type PaletteFile = {
  path: string;
  /** Opens the file, at a line when it has lines. */
  open: (line?: number, column?: number) => void;
};
export type WorkspaceCommand = {
  label: string;
  shortcut?: ShortcutAction;
  disabled?: boolean;
  run: () => void;
};

const maxResults = 50;
const commandPrefix = ">";

/** Text with the characters that the query matched in bold. */
function Highlighted({
  text,
  from = 0,
  positions,
}: {
  text: string;
  /** Where `text` starts in the string that was searched. */
  from?: number;
  positions: ReadonlySet<number>;
}) {
  const parts: { text: string; matched: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const matched = positions.has(from + index);
    const last = parts.at(-1);
    if (last?.matched === matched) last.text += text[index];
    else parts.push({ text: text[index] ?? "", matched });
  }
  return parts.map(({ text, matched }, index) =>
    matched ? (
      <b key={index} className="text-foreground font-semibold">
        {text}
      </b>
    ) : (
      text
    ),
  );
}

type Result = {
  key: string;
  content: ReactNode;
  shortcut?: string;
  run: () => void;
};

/** Go to file, and the command palette behind a leading `>`. */
export function WorkspacePalette({
  request,
  files,
  commands,
  onClose,
}: {
  /** The mode to open in, or null while closed. */
  request: { mode: PaletteMode; sequence: number } | null;
  /** Read while open, in the order to list them without a query. */
  files: () => PaletteFile[];
  commands: () => WorkspaceCommand[];
  onClose: () => void;
}) {
  // Runs after the dialog has closed and given its focus back.
  const chosen = useRef<() => void>(null);
  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        const run = chosen.current;
        chosen.current = null;
        if (!open) run?.();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-[12%] block translate-y-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">
          Go to file or run a command
        </DialogTitle>
        <DialogDescription className="sr-only">
          Type to filter. Start with {commandPrefix} for commands, and end a
          file with a colon and a line number to go to that line.
        </DialogDescription>
        {request && (
          <Palette
            key={request.sequence}
            mode={request.mode}
            files={files}
            commands={commands}
            onRun={(run) => {
              chosen.current = run;
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Palette({
  mode,
  files,
  commands,
  onRun,
}: {
  mode: PaletteMode;
  files: () => PaletteFile[];
  commands: () => WorkspaceCommand[];
  onRun: (run: () => void) => void;
}) {
  const id = useId();
  const { shortcuts } = useSettings();
  const [query, setQuery] = useState(mode === "commands" ? commandPrefix : "");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const [mac] = useState(isMac);

  const inCommands = query.startsWith(commandPrefix);
  // Read once: what is listed must not move while it is being chosen.
  const [available] = useState(() => ({
    files: files(),
    commands: commands(),
  }));
  const results = useMemo<Result[]>(() => {
    if (inCommands)
      return fuzzyFilter(
        query.slice(commandPrefix.length),
        available.commands.filter(({ disabled }) => !disabled),
        ({ label }) => label,
      ).map(({ item, positions }) => ({
        key: item.label,
        content: (
          <span className="min-w-0 flex-1 truncate">
            <Highlighted text={item.label} positions={new Set(positions)} />
          </span>
        ),
        shortcut: item.shortcut ? shortcuts[item.shortcut] : undefined,
        run: item.run,
      }));
    const { text, line, column } = parseFileQuery(query);
    return fuzzyFilter(text, available.files, ({ path }) => path).map(
      ({ item, positions }) => {
        const nameStart = item.path.lastIndexOf("/") + 1;
        const matched = new Set(positions);
        return {
          key: item.path,
          content: (
            <>
              <span className="shrink-0">
                <Highlighted
                  text={item.path.slice(nameStart)}
                  from={nameStart}
                  positions={matched}
                />
              </span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                <Highlighted
                  text={item.path.slice(0, Math.max(0, nameStart - 1))}
                  positions={matched}
                />
              </span>
            </>
          ),
          run: () => item.open(line, column),
        };
      },
    );
  }, [inCommands, query, available, shortcuts]);
  const shown = results.slice(0, maxResults);
  const selected = Math.min(active, shown.length - 1);
  const option = (index: number) => `${id}-option-${index}`;
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  function change(next: string) {
    setQuery(next);
    setActive(0);
  }
  return (
    <div
      onKeyDown={(event) => {
        // Dialogs keep the workspace's shortcuts from running, so the browser
        // would print for Mod+P.
        const chord = eventChord(event.nativeEvent, mac);
        const pressed = (action: ShortcutAction) =>
          !!chord &&
          shortcuts[action].replaceAll(mac ? "Meta" : "Ctrl", "Mod") === chord;
        if (pressed("quickOpen")) {
          event.preventDefault();
          change("");
        } else if (pressed("commandPalette")) {
          event.preventDefault();
          change(commandPrefix);
        }
      }}
    >
      <Input
        autoFocus
        role="combobox"
        aria-label={inCommands ? "Command" : "File"}
        aria-expanded
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={shown.length ? option(selected) : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="Go to file, or type > for commands"
        value={query}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          const step =
            event.key === "ArrowDown"
              ? 1
              : event.key === "ArrowUp"
                ? -1
                : undefined;
          if (step && shown.length) {
            event.preventDefault();
            setActive((selected + step + shown.length) % shown.length);
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const result = shown[selected];
            if (result) onRun(result.run);
          }
        }}
        className="h-11 rounded-none border-0 border-b bg-transparent px-3 focus-visible:ring-0 dark:bg-transparent"
      />
      <ul
        ref={list}
        id={`${id}-list`}
        role="listbox"
        aria-label={inCommands ? "Commands" : "Files"}
        className="max-h-80 overflow-y-auto p-1"
      >
        {shown.map((result, index) => (
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- The input handles the keyboard.
          <li
            key={result.key}
            id={option(index)}
            role="option"
            aria-selected={index === selected}
            className={cn(
              "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              index === selected && "bg-accent text-accent-foreground",
            )}
            onPointerMove={() => setActive(index)}
            onClick={() => onRun(result.run)}
          >
            {result.content}
            {result.shortcut && (
              <Kbd aria-hidden>{bindingLabel(result.shortcut, mac)}</Kbd>
            )}
          </li>
        ))}
      </ul>
      <p
        role="status"
        className={cn(
          "text-muted-foreground px-3 pb-3 text-sm",
          shown.length > 0 && "sr-only",
        )}
      >
        {shown.length
          ? `${results.length} ${results.length === 1 ? "result" : "results"}`
          : inCommands
            ? "No matching commands."
            : "No matching files."}
      </p>
    </div>
  );
}
