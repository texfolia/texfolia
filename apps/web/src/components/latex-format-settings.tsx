import { useEffect, useId, useState } from "react";
import { z } from "zod";

import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { defaultFormatSettings, type FormatSettings } from "#/lib/latex/format";

const storageKey = "texfolia.format";
const settingsSchema = z.object({
  indent: z.number().int().min(1).max(8),
  wrap: z.boolean(),
  width: z.number().int().min(40).max(200),
});

export function useLatexFormatSettings() {
  const [settings, setSettings] = useState(defaultFormatSettings);
  useEffect(() => {
    try {
      const saved = settingsSchema.safeParse(
        JSON.parse(localStorage.getItem(storageKey) ?? "null"),
      );
      if (saved.success) setSettings(saved.data);
    } catch {
      // Keep defaults if browser storage cannot be read.
    }
  }, []);

  function update(next: FormatSettings) {
    setSettings(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Keep the current settings for this session.
    }
  }

  return { settings, update };
}

export function LatexFormatSettings({
  settings,
  onChange,
}: {
  settings: FormatSettings;
  onChange: (settings: FormatSettings) => void;
}) {
  const id = useId();
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" />}>
        Formatting settings
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Formatting settings</DialogTitle>
          <DialogDescription>
            These settings apply to Format document in this browser.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={`${id}-indent`}>Indent width</FieldLabel>
          <Input
            id={`${id}-indent`}
            type="number"
            min={1}
            max={8}
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
      </DialogContent>
    </Dialog>
  );
}
