import { Button } from "@texfolia/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@texfolia/ui/item";
import { Kbd } from "@texfolia/ui/kbd";
import { useState } from "react";

import { editorKeymapLabels } from "#/lib/editor/keymaps/keymaps";
import {
  defaultShortcuts,
  eventChord,
  isMac,
  normalizeBinding,
  shortcutActions,
  shortcutConflicts,
  shortcutIds,
  type ShortcutAction,
  yieldsToKeymap,
} from "#/lib/shortcuts/shortcuts";
import { useSettingsEditing } from "#/providers/settings-provider";

export function ShortcutSettings() {
  const { draft, setDraft } = useSettingsEditing();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const conflicts = shortcutConflicts(draft.shortcuts);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">Keyboard shortcuts</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Mod is ⌘ on Mac and Ctrl on Windows or Linux.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setRecording(null);
            setDraft({ ...draft, shortcuts: defaultShortcuts });
          }}
        >
          Reset all
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">
        Choose Record, press a chord or a sequence of up to four keys, then
        Enter. Escape cancels recording. While typing, only bindings that start
        with Mod, Ctrl, or Alt run, including sequences such as Mod+K S.
      </p>
      {conflicts.length > 0 && (
        <p role="alert" className="text-destructive text-sm">
          Resolve conflicting bindings before applying:{" "}
          {conflicts
            .map(
              ({ first, second }) =>
                `${shortcutActions[first].label} and ${shortcutActions[second].label}`,
            )
            .join("; ")}
          .
        </p>
      )}
      {shortcutIds.map((action) => (
        <ShortcutRow
          key={action}
          action={action}
          conflicting={conflicts.some(
            ({ first, second }) => first === action || second === action,
          )}
          recording={recording === action}
          onRecording={(on) => setRecording(on ? action : null)}
        />
      ))}
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>Browser and editor defaults</ItemTitle>
          <ItemDescription>
            Copy, cut, paste, select all, undo, redo, find, find next/previous,
            find and replace, and Tab / Shift+Tab indentation use your browser
            and editor’s built-in bindings.
          </ItemDescription>
        </ItemContent>
      </Item>
    </div>
  );
}

function ShortcutRow({
  action,
  conflicting,
  recording,
  onRecording,
}: {
  action: ShortcutAction;
  conflicting: boolean;
  recording: boolean;
  onRecording: (recording: boolean) => void;
}) {
  const { draft, setDraft } = useSettingsEditing();
  const [chords, setChords] = useState<string[]>([]);
  const mac = isMac();
  const keymap = draft.editor.keymap;
  const change = (binding: string) =>
    setDraft({
      ...draft,
      shortcuts: { ...draft.shortcuts, [action]: binding },
    });
  return (
    <Item variant="outline" aria-invalid={conflicting}>
      <ItemContent>
        <ItemTitle>{shortcutActions[action].label}</ItemTitle>
        <Kbd className="h-auto w-fit whitespace-normal">
          {recording
            ? chords.join(" → ") || "Press keys…"
            : draft.shortcuts[action].replaceAll(" ", " → ") || "Unassigned"}
        </Kbd>
        {yieldsToKeymap(action, draft.shortcuts[action], keymap, mac) && (
          <ItemDescription>
            Runs outside the editor. In the editor, {editorKeymapLabels[keymap]}{" "}
            uses this key.
          </ItemDescription>
        )}
      </ItemContent>
      <div className="flex gap-2">
        <Button
          variant="outline"
          data-shortcut-recorder
          aria-label={`${recording ? "Recording…" : "Record"} ${shortcutActions[action].label}`}
          aria-pressed={recording}
          onClick={() => {
            onRecording(true);
            setChords([]);
          }}
          onBlur={() => {
            onRecording(false);
            setChords([]);
          }}
          onKeyDown={(event) => {
            if (!recording) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") {
              onRecording(false);
              return;
            }
            if (event.key === "Enter") {
              if (chords.length) change(chords.join(" "));
              onRecording(false);
              return;
            }
            if (event.key === "Backspace") {
              setChords((current) => current.slice(0, -1));
              return;
            }
            if (event.repeat || event.nativeEvent.isComposing) return;
            const chord = eventChord(event.nativeEvent, mac);
            if (chord && normalizeBinding(chord) && chords.length < 4)
              setChords((current) => [...current, chord]);
          }}
        >
          {recording ? "Recording…" : "Record"}
        </Button>
        <Button
          variant="ghost"
          aria-label={`Clear ${shortcutActions[action].label}`}
          disabled={!draft.shortcuts[action]}
          onClick={() => change("")}
        >
          Clear
        </Button>
        <Button
          variant="ghost"
          aria-label={`Reset ${shortcutActions[action].label}`}
          onClick={() => change(defaultShortcuts[action])}
        >
          Reset
        </Button>
      </div>
    </Item>
  );
}
