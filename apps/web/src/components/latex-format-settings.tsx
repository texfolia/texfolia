import { useId } from "react";

import { Checkbox } from "#/components/ui/checkbox";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import type { FormatSettings } from "#/lib/latex/format";
import { formatSettingsSchema as settingsSchema } from "#/lib/settings.schema";

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
          key={`indent-${settings.indent}`}
          defaultValue={settings.indent}
          onBlur={(event) => {
            const value = settingsSchema.shape.indent.safeParse(
              event.target.valueAsNumber,
            );
            if (value.success) onChange({ ...settings, indent: value.data });
            else event.target.value = String(settings.indent);
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
          key={`width-${settings.width}`}
          defaultValue={settings.width}
          disabled={!settings.wrap}
          onBlur={(event) => {
            const value = settingsSchema.shape.width.safeParse(
              event.target.valueAsNumber,
            );
            if (value.success) onChange({ ...settings, width: value.data });
            else event.target.value = String(settings.width);
          }}
        />
      </Field>
    </div>
  );
}
