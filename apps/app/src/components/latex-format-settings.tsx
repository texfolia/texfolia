import { Checkbox } from "@texfolia/ui/checkbox";
import { Field, FieldLabel } from "@texfolia/ui/field";
import { Input } from "@texfolia/ui/input";
import { useId } from "react";

import type { FormatSettings } from "#/features/editor/latex/format";
import { formatSettingsSchema as settingsSchema } from "#/features/settings/settings.schema";

export function LatexFormatSettingsFields({
  settings,
  onChange,
}: {
  settings: FormatSettings;
  onChange: (settings: FormatSettings) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-6">
      <Field>
        <FieldLabel htmlFor={`${id}-indent`}>Indent width</FieldLabel>
        <Input
          id={`${id}-indent`}
          type="number"
          min={1}
          max={8}
          defaultValue={settings.indent}
          onBlur={(event) => {
            if (
              !settingsSchema.shape.indent.safeParse(event.target.valueAsNumber)
                .success
            )
              event.target.value = String(settings.indent);
          }}
          onChange={(event) => {
            const value = settingsSchema.shape.indent.safeParse(
              event.target.valueAsNumber,
            );
            if (value.success) onChange({ ...settings, indent: value.data });
          }}
        />
      </Field>
      <Field orientation="horizontal">
        <Checkbox
          id={`${id}-wrap`}
          checked={settings.wrap}
          onCheckedChange={(wrap) => onChange({ ...settings, wrap })}
        />
        <FieldLabel htmlFor={`${id}-wrap`}>Wrap long lines</FieldLabel>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-width`}>Maximum line width</FieldLabel>
        <Input
          id={`${id}-width`}
          type="number"
          min={40}
          max={200}
          defaultValue={settings.width}
          onBlur={(event) => {
            if (
              !settingsSchema.shape.width.safeParse(event.target.valueAsNumber)
                .success
            )
              event.target.value = String(settings.width);
          }}
          disabled={!settings.wrap}
          onChange={(event) => {
            const value = settingsSchema.shape.width.safeParse(
              event.target.valueAsNumber,
            );
            if (value.success) onChange({ ...settings, width: value.data });
          }}
        />
      </Field>
    </div>
  );
}
