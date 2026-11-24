# Editor

Framework-free editor tooling for the product app's CodeMirror workspace. The
workspace UI (Dockview panels, file tree, preview, status bar) and the React
hooks that drive it stay in `src/routes` and `src/hooks`.

| Entry point                  | Contents                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `#/lib/editor/latex/*`       | LaTeX analysis, completion, editor commands, formatting, highlighting, the language extension, outline, symbols, SyncTeX, and word count |
| `#/lib/editor/latex/workers` | Browser workers for analysis and formatting                                                                                              |
| `#/lib/editor/keymaps/*`     | Vim and Emacs: names, the chords each binds, lazy loading, and the undo hook for Yjs history                                             |
| `#/lib/editor/spelling/*`    | The spell checker, its worker, prose extraction, dictionaries, and the CodeMirror lint extension                                         |
| `#/lib/editor/themes`        | The UIW theme catalog, appearance schema and migration, and lazy theme loading                                                           |
| `#/lib/editor/theme-editor`  | The CodeMirror extension for the selected theme                                                                                          |

Workers are created with `new URL("./x.worker.ts", import.meta.url)` inside the
feature, so the app's Vite build emits each one as its own asset. The format
worker loads `core/texfmt` and the spelling worker loads `dictionaries/` from the
app's origin; the app copies those assets before `dev` and `build`.

Compile integration (build history, compile logs, source sync, shared PDFs) is
not part of this feature. It lives in `#/lib/compile`.

## Theme catalog

`themes/theme-catalog.gen.ts` is generated from `@uiw/codemirror-themes-all`.
Regenerate it after upgrading the UIW theme packages:

```sh
bun run --cwd apps/app themes:catalog
```

## Checks

```sh
bun test apps/app/src/lib/editor
```

The SyncTeX fixture in `apps/app/test/fixtures/synctex` is also used by the
`test:synctex` browser suite.
