import { useId, useState } from "react";

import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import {
  bundledThemeIdSchema,
  bundledThemes,
  maxThemeBytes,
} from "#/lib/themes";
import { useTheme } from "#/providers/theme-provider";

export function AppearanceSettings() {
  const { theme, appearance, choose, importTheme, setPdfMode, error } =
    useTheme();
  const id = useId();
  const [source, setSource] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const selection = appearance.selection;

  function apply(source: string) {
    try {
      importTheme(source);
      setImportError(null);
      setImported("Theme imported and applied.");
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : "Could not import this theme. Try another JSON file.",
      );
      setImported(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-medium">Your workspace, your colors</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Themes apply instantly to every app page and editor. Saved for your
          account in this browser. Marketing pages keep Texfolia’s styling.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-theme`}>Theme</FieldLabel>
        <select
          id={`${id}-theme`}
          value={
            selection.kind === "system"
              ? "system"
              : selection.kind === "imported"
                ? "imported"
                : selection.id
          }
          className="border-border bg-input text-foreground focus-visible:ring-ring h-9 w-full rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
          onChange={(event) => {
            if (event.target.value === "system") choose({ kind: "system" });
            else {
              const parsed = bundledThemeIdSchema.safeParse(event.target.value);
              if (parsed.success) choose({ kind: "bundled", id: parsed.data });
            }
          }}
        >
          <option value="system">Follow system appearance</option>
          {Object.entries(bundledThemes).map(([id, theme]) => (
            <option key={id} value={id}>
              {theme.name}
            </option>
          ))}
          {selection.kind === "imported" && (
            <option value="imported">{selection.theme.name} (imported)</option>
          )}
        </select>
        <p className="text-muted-foreground text-xs" role="status">
          {theme.name} · {theme.mode}
        </p>
      </Field>
      <Field orientation="horizontal">
        <Checkbox
          id={`${id}-pdf`}
          checked={appearance.pdfMode === "match"}
          onCheckedChange={(checked) =>
            setPdfMode(checked ? "match" : "original")
          }
        />
        <FieldLabel htmlFor={`${id}-pdf`}>
          Match PDF preview to theme
        </FieldLabel>
      </Field>
      <div className="space-y-3 border-t pt-5">
        <h3 className="font-medium">Import a VS Code theme</h3>
        <p className="text-muted-foreground text-sm">
          Upload or paste a standalone color theme JSON (up to 1 MB). Comments
          and trailing commas are supported.
        </p>
        <Field>
          <FieldLabel htmlFor={`${id}-file`}>Upload theme JSON</FieldLabel>
          <Input
            id={`${id}-file`}
            type="file"
            accept=".json,.jsonc,application/json"
            className="h-auto py-2"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > maxThemeBytes) {
                setImportError("Choose a theme smaller than 1 MB.");
                return;
              }
              try {
                apply(await file.text());
              } catch {
                setImportError("Could not read this file. Choose it again.");
              }
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-json`}>Paste theme JSON</FieldLabel>
          <Textarea
            id={`${id}-json`}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="max-h-56 min-h-28 font-mono text-xs"
            placeholder={
              '{ "name": "My theme", "colors": { … }, "tokenColors": [ … ] }'
            }
            spellCheck={false}
          />
        </Field>
        {importError && (
          <p role="alert" className="text-destructive text-sm">
            {importError}
          </p>
        )}
        {imported && (
          <p role="status" className="text-muted-foreground text-sm">
            {imported}
          </p>
        )}
        <Button
          type="button"
          disabled={!source.trim()}
          onClick={() => apply(source)}
        >
          Import and apply
        </Button>
        <p className="text-muted-foreground text-xs">
          TextMate scopes use the nearest syntax category. Semantic tokens, icon
          themes, extension packages and external includes are not imported.
        </p>
      </div>
    </div>
  );
}
