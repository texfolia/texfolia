# Themes

Settings > Appearance controls the app theme and CodeMirror colors together.
Choose a bundled theme, follow system appearance, or import a standalone VS Code
color theme. Marketing pages retain their own styling. Appearance is stored in
local storage under `texfolia.appearance.v1:<userId>` and shared between tabs in
that browser. It does not sync between devices. Editor and formatting preferences
have a separate account-synced store.

The default follows system appearance. Selecting another bundled theme replaces
the imported selection. The app migrates the old editor-only theme preference
when no account-scoped appearance exists. If browser storage is unavailable,
theme changes still apply to the current session and an error explains that the
preference could not be saved.

PDFs retain their original page colors by default. **Match PDF preview to theme**
changes the preview surround and applies inversion for dark themes. Downloads
and exports retain the original PDF bytes.

## Import limits

Upload or paste the color theme JSON in Settings > Appearance. Comments, trailing
commas, and a leading byte-order mark are accepted. The parser rejects files over
1 MiB, themes that reference another file with `include`, and files without colors
or token rules. Combine included files before importing.

Colors must be hex values with 3, 4, 6, or 8 digits. The schema permits up to
2,000 UI color entries and 4,000 token rules. Font styles can contain `italic`,
`bold`, `underline`, and `strikethrough`. TextMate scopes map to CodeMirror tags;
unsupported scopes do not create new syntax categories. Missing UI colors fall
back to the palette derived from the editor background and foreground. Importing
a theme does not load extension code, remote resources, CSS, or executable scripts.

## Implementation and verification

[themes.ts](../apps/web/src/lib/themes.ts) owns parsing, bundled palettes, storage
shape, and the mapping to app tokens. [theme-syntax.ts](../apps/web/src/lib/theme-syntax.ts)
maps syntax rules. [theme-editor.ts](../apps/web/src/lib/theme-editor.ts) builds the
CodeMirror extension with `@uiw/codemirror-themes`. The full UIW theme bundle is
unused. [ThemeProvider](../apps/web/src/providers/theme-provider.tsx) applies the
palette and handles persistence. The constrained
[bootstrap](../apps/web/src/lib/theme-bootstrap.ts) applies cached colors before
hydration and clears app colors outside the app routes.

Run parser, token mapping, persistence, and bootstrap checks from the repo root:

```sh
bun test apps/web/src/lib/themes.test.ts
```

Component styles use Tailwind classes. The stylesheet contains theme variables,
font setup, imports, and the Dockview variable-mapping utility. Runtime theme
values and CodeMirror style specifications use their supported APIs.
