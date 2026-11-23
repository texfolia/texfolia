import {
  IconCode,
  IconKeyboard,
  IconPalette,
  IconTextSpellcheck,
  IconX,
} from "@tabler/icons-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@texfolia/ui/alert-dialog";
import { Button } from "@texfolia/ui/button";
import { Checkbox } from "@texfolia/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@texfolia/ui/dialog";
import { Field, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from "@texfolia/ui/item";
import { Kbd } from "@texfolia/ui/kbd";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@texfolia/ui/tabs";
import { useId, useState } from "react";

import { AppearanceSettings } from "#/components/appearance-settings";
import { LatexFormatSettingsFields } from "#/components/latex-format-settings";
import {
  editorKeymapLabels,
  editorKeymaps,
} from "#/features/editor/keymaps/keymaps";
import {
  spellingDictionaries,
  spellingLanguages,
  spellingLanguageSchema,
} from "#/features/editor/spelling/languages";
import {
  addPersonalWord,
  autoCompileDelays,
  maxPersonalWords,
  personalWord,
} from "#/lib/settings.schema";
import {
  defaultShortcuts,
  eventChord,
  normalizeBinding,
  shortcutActions,
  shortcutConflicts,
  shortcutIds,
  type ShortcutAction,
  yieldsToKeymap,
} from "#/lib/shortcuts";
import {
  type SettingsSection,
  useSettings,
} from "#/providers/settings-provider";

const sections = [
  { title: "Appearance", icon: IconPalette },
  { title: "Editor", icon: IconCode },
  { title: "Spelling", icon: IconTextSpellcheck },
  { title: "Keyboard shortcuts", icon: IconKeyboard },
] satisfies { title: SettingsSection; icon: typeof IconCode }[];

export function SettingsDialog() {
  const settings = useSettings();
  return (
    <>
      <Dialog open={settings.open} onOpenChange={settings.setOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>
              User preferences apply in this browser. Project settings are
              shared with collaborators.
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={!settings.ready || settings.saving}
            className="flex min-h-0 flex-1 flex-col"
          >
            <Tabs defaultValue="user" className="min-h-0 gap-4">
              <TabsList aria-label="Settings scope" className="shrink-0">
                <TabsTrigger value="user" className="px-5">
                  User
                </TabsTrigger>
                <TabsTrigger value="project" className="px-5">
                  Project
                </TabsTrigger>
              </TabsList>
              <TabsContent value="user" className="min-h-0">
                <UserSettingsSections />
              </TabsContent>
              <TabsContent value="project" className="min-h-0 overflow-y-auto">
                <div className="min-h-64 py-1">
                  <Item variant="outline" className="items-start">
                    <ItemContent>
                      <ItemTitle>LaTeX formatting</ItemTitle>
                      <ItemDescription>
                        Applied when you run Format document. These settings are
                        shared by everyone in this project.
                      </ItemDescription>
                      {!settings.project?.canWrite && (
                        <p className="text-muted-foreground text-sm">
                          You have view access. A project editor can change
                          these settings.
                        </p>
                      )}
                      <fieldset
                        disabled={!settings.project?.canWrite}
                        className="mt-5"
                      >
                        {settings.draftFormatting && (
                          <LatexFormatSettingsFields
                            settings={settings.draftFormatting}
                            onChange={settings.setDraftFormatting}
                          />
                        )}
                      </fieldset>
                    </ItemContent>
                  </Item>
                  <ProjectSpellingFields />
                </div>
              </TabsContent>
            </Tabs>
          </fieldset>
          <SettingsFooter />
        </DialogContent>
      </Dialog>
      <SettingsCloseGuard />
    </>
  );
}

export function UserSettingsSections() {
  const { section, setSection, userReady } = useSettings();
  return (
    <div className="flex h-[min(34rem,calc(100dvh-19rem))] min-h-32 flex-col gap-5 sm:flex-row">
      <nav
        aria-label="User settings sections"
        className="flex shrink-0 flex-wrap gap-1 sm:w-44 sm:flex-col"
      >
        {sections.map(({ title, icon: Icon }) => (
          <Button
            key={title}
            variant={section === title ? "secondary" : "ghost"}
            className="justify-start"
            aria-current={section === title ? "page" : undefined}
            onClick={() => setSection(title)}
          >
            <Icon />
            {title}
          </Button>
        ))}
      </nav>
      <section
        aria-label={section}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1"
      >
        {section === "Appearance" && (
          <Item variant="outline">
            <ItemContent>
              <AppearanceSettings />
            </ItemContent>
          </Item>
        )}
        {section === "Editor" && (
          <fieldset disabled={!userReady}>
            <EditorSettingsFields />
          </fieldset>
        )}
        {section === "Spelling" && (
          <fieldset disabled={!userReady}>
            <PersonalDictionaryFields />
          </fieldset>
        )}
        {section === "Keyboard shortcuts" && (
          <fieldset disabled={!userReady}>
            <ShortcutSettingsFields />
          </fieldset>
        )}
      </section>
    </div>
  );
}

function EditorSettingsFields() {
  const { draft, setDraft } = useSettings();
  const id = useId();
  return (
    <Item variant="outline">
      <ItemContent className="gap-5">
        <div>
          <ItemTitle>Editor</ItemTitle>
          <ItemDescription>
            Font, line wrapping, keymap, and saving are your preferences in this
            browser.
          </ItemDescription>
        </div>
        <Field>
          <FieldLabel htmlFor={`${id}-font`}>Editor font size</FieldLabel>
          <Input
            id={`${id}-font`}
            type="number"
            min={10}
            max={24}
            defaultValue={draft.editor.fontSize}
            onBlur={(event) => {
              const size = event.target.valueAsNumber;
              if (!Number.isInteger(size) || size < 10 || size > 24)
                event.target.value = String(draft.editor.fontSize);
            }}
            onChange={(event) => {
              const fontSize = event.target.valueAsNumber;
              if (
                Number.isInteger(fontSize) &&
                fontSize >= 10 &&
                fontSize <= 24
              )
                setDraft({ ...draft, editor: { ...draft.editor, fontSize } });
            }}
          />
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id={`${id}-wrap`}
            checked={draft.editor.wrapLines}
            onCheckedChange={(wrapLines) =>
              setDraft({ ...draft, editor: { ...draft.editor, wrapLines } })
            }
          />
          <FieldLabel htmlFor={`${id}-wrap`}>
            Wrap lines in the editor
          </FieldLabel>
        </Field>
        <p className="text-muted-foreground text-xs">
          The editor toolbar’s Wrap lines control saves immediately.
        </p>
        <Field>
          <FieldLabel htmlFor={`${id}-keymap`}>Keymap</FieldLabel>
          <NativeSelect
            id={`${id}-keymap`}
            value={draft.editor.keymap}
            onChange={(event) => {
              const keymap = editorKeymaps.find(
                (keymap) => keymap === event.target.value,
              );
              if (keymap)
                setDraft({ ...draft, editor: { ...draft.editor, keymap } });
            }}
          >
            {editorKeymaps.map((keymap) => (
              <NativeSelectOption key={keymap} value={keymap}>
                {editorKeymapLabels[keymap]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <p className="text-muted-foreground text-xs">
          Vim and Emacs keep the Ctrl and Alt keys they use while the editor has
          focus. Save, Save &amp; compile, Clean build, and tab switching keep
          their shortcuts everywhere.
        </p>
        <Field orientation="horizontal">
          <Checkbox
            id={`${id}-compile`}
            checked={draft.compile.onSave}
            onCheckedChange={(onSave) =>
              setDraft({ ...draft, compile: { ...draft.compile, onSave } })
            }
          />
          <FieldLabel htmlFor={`${id}-compile`}>
            Compile after saving
          </FieldLabel>
        </Field>
        <p className="text-muted-foreground text-xs">
          Save reuses the build cache. Save without compiling and Clean build
          stay available in the File menu and as shortcuts.
        </p>
        <Field>
          <FieldLabel htmlFor={`${id}-auto-compile`}>
            Compile after editing stops
          </FieldLabel>
          <NativeSelect
            id={`${id}-auto-compile`}
            value={String(draft.compile.afterIdle)}
            onChange={(event) => {
              const afterIdle = autoCompileDelays.find(
                (seconds) => String(seconds) === event.target.value,
              );
              if (afterIdle !== undefined)
                setDraft({
                  ...draft,
                  compile: { ...draft.compile, afterIdle },
                });
            }}
          >
            {autoCompileDelays.map((seconds) => (
              <NativeSelectOption key={seconds} value={seconds}>
                {seconds ? `After ${seconds}s idle` : "Off"}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <p className="text-muted-foreground text-xs">
          Saves and compiles once you stop typing. Builds count toward your
          plan’s usage limits, and pause if a limit is reached until you compile
          manually.
        </p>
      </ItemContent>
    </Item>
  );
}

function ProjectSpellingFields() {
  const settings = useSettings();
  const id = useId();
  if (!settings.draftSpelling) return null;
  return (
    <Item variant="outline" className="mt-4 items-start">
      <ItemContent>
        <ItemTitle>Spelling</ItemTitle>
        <ItemDescription>
          Checks prose in LaTeX files, skipping commands, math, comments and
          label, reference and citation keys. Shared by everyone in this
          project.
        </ItemDescription>
        <fieldset disabled={!settings.project?.canWrite} className="mt-5">
          <Field>
            <FieldLabel htmlFor={`${id}-language`}>
              Spell-check language
            </FieldLabel>
            <NativeSelect
              id={`${id}-language`}
              value={settings.draftSpelling}
              onChange={(event) => {
                const language = spellingLanguageSchema.safeParse(
                  event.target.value,
                );
                if (language.success) settings.setDraftSpelling(language.data);
              }}
            >
              {spellingLanguages.map((language) => (
                <NativeSelectOption key={language} value={language}>
                  {language === "off"
                    ? "Off"
                    : spellingDictionaries[language].label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </fieldset>
      </ItemContent>
    </Item>
  );
}

function PersonalDictionaryFields() {
  const { draft, setDraft } = useSettings();
  const id = useId();
  const [word, setWord] = useState("");
  const words = draft.spelling.words;
  const next = personalWord(word);
  const full = words.length >= maxPersonalWords;
  const setWords = (words: string[]) =>
    setDraft({ ...draft, spelling: { words } });
  return (
    <Item variant="outline">
      <ItemContent className="gap-5">
        <div>
          <ItemTitle>Personal dictionary</ItemTitle>
          <ItemDescription>
            Words here are never flagged in any project or language. They are
            stored in this browser. Lowercase words also match capitalized
            forms. Add to dictionary in the editor saves immediately.
          </ItemDescription>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!next || full) return;
            setWords(addPersonalWord(words, next));
            setWord("");
          }}
        >
          <Field className="flex-1">
            <FieldLabel htmlFor={`${id}-word`} className="sr-only">
              Word
            </FieldLabel>
            <Input
              id={`${id}-word`}
              value={word}
              placeholder="Add a word"
              maxLength={64}
              aria-invalid={!!word.trim() && !next}
              onChange={(event) => setWord(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={!next || full || words.includes(next)}
          >
            Add
          </Button>
        </form>
        {word.trim() && !next && (
          <p role="alert" className="text-destructive text-xs">
            Enter one word of up to 64 characters, without spaces or LaTeX.
          </p>
        )}
        {full && (
          <p className="text-muted-foreground text-xs">
            Your dictionary holds the maximum of {maxPersonalWords} words.
          </p>
        )}
        {words.length ? (
          <ul
            aria-label="Personal dictionary words"
            className="flex flex-wrap gap-2"
          >
            {words.map((entry) => (
              <li
                key={entry}
                className="bg-muted flex items-center gap-1 rounded-sm py-0.5 pr-0.5 pl-2 text-sm"
              >
                {entry}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${entry}`}
                  onClick={() =>
                    setWords(words.filter((existing) => existing !== entry))
                  }
                >
                  <IconX />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No words yet.</p>
        )}
      </ItemContent>
    </Item>
  );
}

function ShortcutSettingsFields() {
  const { draft, setDraft } = useSettings();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [chords, setChords] = useState<string[]>([]);
  const conflicts = shortcutConflicts(draft.shortcuts);
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);
  const keymap = draft.editor.keymap;
  const change = (action: ShortcutAction, binding: string) =>
    setDraft({
      ...draft,
      shortcuts: { ...draft.shortcuts, [action]: binding },
    });
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
        <Item
          variant="outline"
          key={action}
          aria-invalid={conflicts.some(
            ({ first, second }) => first === action || second === action,
          )}
        >
          <ItemContent>
            <ItemTitle>{shortcutActions[action].label}</ItemTitle>
            <Kbd className="h-auto w-fit whitespace-normal">
              {recording === action
                ? chords.join(" → ") || "Press keys…"
                : draft.shortcuts[action].replaceAll(" ", " → ") ||
                  "Unassigned"}
            </Kbd>
            {yieldsToKeymap(action, draft.shortcuts[action], keymap, mac) && (
              <ItemDescription>
                Runs outside the editor. In the editor,{" "}
                {editorKeymapLabels[keymap]} uses this key.
              </ItemDescription>
            )}
          </ItemContent>
          <div className="flex gap-2">
            <Button
              variant="outline"
              data-shortcut-recorder
              aria-label={`Record ${shortcutActions[action].label}`}
              aria-pressed={recording === action}
              onClick={() => {
                setRecording(action);
                setChords([]);
              }}
              onBlur={() => {
                setRecording(null);
                setChords([]);
              }}
              onKeyDown={(event) => {
                if (recording !== action) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape") {
                  setRecording(null);
                  return;
                }
                if (event.key === "Enter") {
                  if (chords.length) change(action, chords.join(" "));
                  setRecording(null);
                  return;
                }
                if (event.key === "Backspace") {
                  setChords((current) => current.slice(0, -1));
                  return;
                }
                if (event.repeat || event.nativeEvent.isComposing) return;
                const chord = eventChord(
                  event.nativeEvent,
                  /Mac|iPhone|iPad/.test(navigator.platform),
                );
                if (chord && normalizeBinding(chord) && chords.length < 4)
                  setChords((current) => [...current, chord]);
              }}
            >
              {recording === action ? "Recording…" : "Record"}
            </Button>
            <Button
              variant="ghost"
              aria-label={`Clear ${shortcutActions[action].label}`}
              disabled={!draft.shortcuts[action]}
              onClick={() => change(action, "")}
            >
              Clear
            </Button>
            <Button
              variant="ghost"
              aria-label={`Reset ${shortcutActions[action].label}`}
              onClick={() => change(action, defaultShortcuts[action])}
            >
              Reset
            </Button>
          </div>
        </Item>
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

export function SettingsFooter({
  onSave,
  onCancel,
}: {
  onSave?: () => void;
  onCancel?: () => void;
}) {
  const settings = useSettings();
  return (
    <footer className="mt-4 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-4">
      <div className="mr-auto min-w-0 basis-full text-sm sm:basis-auto">
        <p role="status" className="text-muted-foreground">
          {!settings.ready
            ? "Loading preferences…"
            : settings.saving
              ? "Saving settings…"
              : settings.dirty
                ? "Unsaved changes"
                : "All changes saved"}
        </p>
        {settings.error && (
          <p role="alert" className="text-destructive mt-1">
            {settings.error}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        disabled={settings.saving}
        onClick={() => {
          settings.discard();
          onCancel?.();
        }}
      >
        Cancel
      </Button>
      <Button
        variant="outline"
        disabled={!settings.ready || settings.saving || !settings.dirty}
        onClick={() => void settings.apply()}
      >
        Apply
      </Button>
      <Button
        disabled={!settings.ready || settings.saving}
        onClick={() =>
          void settings.apply(true).then((saved) => {
            if (saved) onSave?.();
          })
        }
      >
        Save
      </Button>
    </footer>
  );
}

export function SettingsCloseGuard({
  open,
  onKeepEditing,
  onDiscard,
  onApply,
}: {
  open?: boolean;
  onKeepEditing?: () => void;
  onDiscard?: () => void;
  onApply?: () => void;
}) {
  const settings = useSettings();
  return (
    <AlertDialog
      open={open ?? settings.closeGuard}
      onOpenChange={(next) => {
        if (!next) {
          settings.setCloseGuard(false);
          onKeepEditing?.();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Unsaved settings changes</AlertDialogTitle>
        <AlertDialogDescription>
          Apply your changes and keep Settings open, or discard them before
          leaving.
        </AlertDialogDescription>
        {settings.error && (
          <p role="alert" className="text-destructive text-sm">
            {settings.error}
          </p>
        )}
        <AlertDialogFooter>
          <Button
            variant="outline"
            disabled={settings.saving}
            onClick={() => {
              settings.setCloseGuard(false);
              onKeepEditing?.();
            }}
          >
            Keep editing
          </Button>
          <Button
            variant="outline"
            disabled={settings.saving}
            onClick={() => {
              settings.discard();
              onDiscard?.();
            }}
          >
            Discard
          </Button>
          <Button
            disabled={settings.saving}
            onClick={() =>
              void settings.apply().then((saved) => {
                if (saved) onApply?.();
              })
            }
          >
            {settings.saving ? "Applying…" : "Apply"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
