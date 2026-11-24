import { IconCheck } from "@tabler/icons-react";
import { Checkbox } from "@texfolia/ui/checkbox";
import { Field, FieldLabel } from "@texfolia/ui/field";
import { useEffect, useId, useState } from "react";

import { themeCatalog, type Appearance } from "#/lib/editor/themes/themes";
import { useTheme } from "#/providers/theme-provider";

export function AppearanceSettings() {
  const { theme, appearance, choose, preview, setDraftPdfMode, error } =
    useTheme();
  const id = useId();
  const [hovered, setHovered] = useState<Appearance["selection"] | null>(null);
  const [focused, setFocused] = useState<Appearance["selection"] | null>(null);
  useEffect(() => {
    preview(hovered ?? focused);
    return () => preview(null);
  }, [hovered, focused, preview]);
  const options = [
    {
      name: "Follow system appearance",
      mode: "GitHub Light / Dark",
      selection: { kind: "system" } satisfies Appearance["selection"],
    },
    ...themeCatalog.map(({ id, name, mode }) => ({
      name,
      mode,
      selection: { kind: "theme", id } satisfies Appearance["selection"],
    })),
  ];
  return (
    <div className="@container/appearance space-y-6">
      <div>
        <h3 className="font-medium">Workspace theme</h3>
        <p id={`${id}-hint`} className="text-muted-foreground mt-1 text-sm">
          Hover or focus to preview. Select a theme, then Apply or Save to keep
          it.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div
        role="group"
        aria-label="Theme"
        aria-describedby={`${id}-hint`}
        className="grid gap-1 @min-[28rem]/appearance:grid-cols-2"
      >
        {options.map(({ name, mode, selection }) => {
          const selected =
            appearance.selection.kind === selection.kind &&
            (appearance.selection.kind === "system" ||
              (selection.kind === "theme" &&
                appearance.selection.id === selection.id));
          return (
            <button
              key={selection.kind === "system" ? "system" : selection.id}
              type="button"
              aria-label={name}
              aria-pressed={selected}
              className="hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring aria-pressed:border-border aria-pressed:bg-accent aria-pressed:text-accent-foreground flex min-h-11 items-center gap-2 rounded-md border border-transparent px-3 py-2 text-left text-sm outline-none focus-visible:ring-2"
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") setHovered(selection);
              }}
              onPointerLeave={() => setHovered(null)}
              onPointerCancel={() => setHovered(null)}
              onFocus={() => setFocused(selection)}
              onBlur={() => setFocused(null)}
              onClick={() => choose(selection)}
            >
              <span className="min-w-0 flex-1">
                <span className="block">{name}</span>
                <span className="text-muted-foreground block text-xs capitalize">
                  {mode}
                </span>
              </span>
              {selected && <IconCheck className="size-4 shrink-0" />}
            </button>
          );
        })}
      </div>
      <p className="text-muted-foreground text-xs" role="status">
        Preview: {theme.name} · {theme.mode}
      </p>
      <Field orientation="horizontal">
        <Checkbox
          id={`${id}-pdf`}
          checked={appearance.pdfMode === "match"}
          onCheckedChange={(checked) =>
            setDraftPdfMode(checked ? "match" : "original")
          }
        />
        <FieldLabel htmlFor={`${id}-pdf`}>
          Match PDF preview to theme
        </FieldLabel>
      </Field>
    </div>
  );
}
