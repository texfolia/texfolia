import { Checkbox } from "@texfolia/ui/checkbox";
import { Field, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@texfolia/ui/item";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";
import { useId, useState } from "react";

import {
  editorKeymapLabels,
  editorKeymaps,
} from "#/lib/editor/keymaps/keymaps";
import { autoCompileDelays } from "#/lib/settings/settings.schema";
import { useSettingsEditing } from "#/providers/settings-provider";

export function EditorSettings() {
  const { draft, setDraft } = useSettingsEditing();
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
        <FontSizeField />
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

const fontSizes = { min: 10, max: 24 };

function FontSizeField() {
  const { draft, setDraft } = useSettingsEditing();
  const id = useId();
  // What is being typed, which may not be a size yet.
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <Field>
      <FieldLabel htmlFor={id}>Editor font size</FieldLabel>
      <Input
        id={id}
        type="number"
        min={fontSizes.min}
        max={fontSizes.max}
        value={typed ?? draft.editor.fontSize}
        onBlur={() => setTyped(null)}
        onChange={(event) => {
          setTyped(event.target.value);
          const fontSize = event.target.valueAsNumber;
          if (
            Number.isInteger(fontSize) &&
            fontSize >= fontSizes.min &&
            fontSize <= fontSizes.max
          )
            setDraft({ ...draft, editor: { ...draft.editor, fontSize } });
        }}
      />
    </Field>
  );
}
