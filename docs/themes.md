# App themes

Texfolia uses one theme definition for app colors, CodeMirror colors, and syntax highlighting. **Settings → Appearance** provides bundled palettes, system appearance, and VS Code theme import. Preferences are stored per account in the current browser. They do not sync between devices.

## Ownership and first paint

`lib/themes.ts` validates theme JSON and resolves missing colors from the editor background and foreground. Its output contains shadcn tokens, IDE tokens, editor settings, and syntax styles. `lib/theme-editor.ts` turns that output into CodeMirror extensions with `createTheme` and `EditorView.theme`.

`ThemeProvider` owns the selected theme and PDF mode. The authenticated projects, workspace, and invitation routes mount this provider. It applies tokens to the document root so dialogs, tooltips, and toasts inherit the same colors. Its layout effect applies changes before paint and removes them on unmount.

The root route loads the authenticated user for app paths. The head script reads `texfolia.appearance.v1:<userId>` before paint. A saved preference contains both the source selection and a derived palette preview, written together. The script accepts only known token names and validated hex colors or compiler-generated color mixes. System appearance resolves against the current OS setting rather than a stale cached mode.

Marketing routes never receive this script. A route-aware layout effect also clears app tokens when entering a public route, including after an app loader error.

## Why the provider lives at the account boundary

A root-only provider would need to infer account identity before choosing browser preferences. The account boundary already knows the authenticated user and can read that user's preference synchronously. A DOM-only theme boundary would isolate marketing, but require custom portal containers throughout the UI. Applying tokens to the root during the app's lifetime preserves existing portal behavior. The head script covers hard loads, and the public-route reset covers navigation.

The design combines the account boundary from the scoped-provider sketch with the root palette and bootstrap from the root-provider sketch. Both sketches agreed on a pure converter, strict color validation, the existing LaTeX grammar, and a separate BibTeX tokenizer.

## Import format and limits

The importer accepts standalone VS Code color theme JSON with comments and trailing commas, up to 1 MB. `colors` values and token foregrounds accept RGB or RGBA hex values, including shorthand. Font styles accept bold, italic, underline, and strikethrough. Imported selectors and metadata never become CSS selectors or declarations.

`lib/theme-syntax.ts` maps TextMate scopes to Lezer tags. Rules resolve each property independently by the longest dot-prefix match. Later rules win ties. An empty `fontStyle` resets earlier styles. Complex ancestor selectors use their final scope as an approximation. Semantic tokens, icons, VSIX packages, external includes, and Open VSX browsing are outside this implementation.

The bundled palettes share the converter with imported themes. They include Texfolia, Light+, Dark+, One Dark, GitHub Light and Dark, Solarized Light and Dark, Dracula, Nord, and Xcode Light.

## LaTeX and PDF behavior

`lib/latex/highlight.ts` extends the existing `codemirror-lang-latex` Lezer grammar with tags for commands, environments, math, arguments, and options. It preserves the package's language support, including folding and environment completion. Option keys get a separate decoration because the upstream grammar does not split key-value text. BibTeX uses a separate stream tokenizer for fields, entry types, citation keys, and nested values.

Dockview variables map to the app's tab, border, selection, and popover tokens. The PDF toolbar switches between true colors and matching the theme. Matching uses the theme's surround color and inverts rendered pages in dark mode. Downloaded PDFs retain their original colors.

## Verification

`bun test apps/web/src/lib/themes.test.ts` checks imports, CSS rejection, selector matching, grammar tags, BibTeX values, and the exact head-script source. `bun run typecheck`, `bun run test`, and `bun run --cwd apps/web build` cover repository integration.

Browser checks still need to cover a hard reload, app-to-marketing navigation, OS changes, account changes, import errors, and the PDF toggle at desktop and mobile widths.
