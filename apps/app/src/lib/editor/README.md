# Editor

Framework-free editor tooling for the product app's CodeMirror workspace. The
workspace UI (Dockview panels, file tree, preview, status bar) and the React
hooks that drive it stay in `src/routes` and `src/hooks`.

| Entry point                       | Contents                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@texfolia/codemirror-lang-latex` | Clean-room Lezer LaTeX grammar, syntax linter, built-in completions, and BibTeX language         |
| `@texfolia/tex-fmt`               | WebAssembly build and TypeScript wrapper for upstream MIT `tex-fmt`                              |
| `@texfolia/editor`                | Framework-agnostic LaTeX editor extensions, analysis, outline, word count, BibTeX, and symbols   |
| `#/lib/editor/latex/*`            | App-side browser workers (`analysis.worker`, `format.worker`, `formatter`) and SyncTeX           |
| `#/lib/editor/keymaps/*`          | Vim and Emacs: names, the chords each binds, lazy loading, and the undo hook for Yjs history     |
| `#/lib/editor/spelling/*`         | The spell checker, its worker, prose extraction, dictionaries, and the CodeMirror lint extension |
| `#/lib/editor/themes`             | The UIW theme catalog, appearance schema and migration, and lazy theme loading                   |
| `#/lib/editor/theme-editor`       | The CodeMirror extension for the selected theme                                                  |

Workers are created with `new URL("./x.worker.ts", import.meta.url)` inside the
feature, so the app's Vite build emits each one as its own asset. Every editor tab
shares one format worker and one spelling worker, and `LatexAnalyzer` keeps one
analysis worker per workspace while files come and go. A worker that fails is
terminated and replaced on the next request. The format worker uses
`@texfolia/tex-fmt` (whose WASM asset is bundled by Vite) and the spelling
worker loads `dictionaries/` from the app's origin; the app copies spelling
dictionaries before `dev` and `build`.

Compile integration (build history, compile logs, source sync, shared PDFs) is
not part of this feature. It lives in `#/lib/compile`.

## Theme catalog

`themes/theme-catalog.gen.ts` and `themes/theme-loaders.gen.ts` are generated from
`@uiw/codemirror-themes-all`. Every page loads `themes.ts` and the catalog to apply
the theme's colors, so they must import neither CodeMirror nor Zod. Only pages with
an editor load `theme-extensions.ts` and the loaders; a test checks this. Regenerate
both files after upgrading the UIW theme packages:

```sh
bun run --cwd apps/app themes:catalog
```

## Checks

```sh
bun test apps/app/src/lib/editor
```

`bun run --cwd apps/app test:editor-runtime` runs the workspace in a browser and
checks what typing renders, undo across settings and access changes, the
clipboard, worker counts, and layout writes.
`test:editor-features` uses the same fixture (`test/editor-runtime/harness.ts`) to
check previews, the main document, go to file, and the assistant's changes. Set
`SCREENSHOT_DIR` to save its screenshots.

The SyncTeX fixture in `apps/app/test/fixtures/synctex` is also used by the
`test:synctex` browser suite.
