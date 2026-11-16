# Themes

Settings > Appearance controls workspace colors and the CodeMirror editor together.
The theme list contains every theme exported by `@uiw/codemirror-themes-all`.
Marketing pages retain their brand styling.

The default, **Follow system appearance**, uses GitHub Light or GitHub Dark as
system appearance changes. Hovering or focusing a theme previews it throughout
the workspace, including open editors. Moving away restores the selected draft
or committed theme. Touch users select a theme by tapping it.

In the editor, Settings opens as a dock panel alongside file tabs. Opening it
again reveals the same tab. Outside the editor, the existing Settings dialog
uses the same Appearance controls.

Selecting a theme changes the appearance draft without writing storage.
**Apply** saves it and keeps Settings open with no unsaved appearance changes.
**Save** saves and closes. **Cancel** discards the appearance draft and closes.
Closing Settings with unsaved appearance changes prompts for **Apply**,
**Discard**, or **Keep editing**. Apply in that prompt also keeps Settings open.
Other editor and formatting controls retain their existing immediate-save behavior;
the broader settings draft redesign belongs to NAT-311.

PDFs retain their original page colors by default. **Match PDF preview to theme**
in Settings joins the appearance draft. The PDF viewer's separate control saves
immediately. Matching changes the preview surround and applies inversion for dark
themes. Downloads and exports retain the original PDF bytes.

## Storage and migration

Appearance is stored per account in `texfolia.appearance.v2:<userId>` in this
browser, including the selection, PDF mode, and a cached CSS preview for the head
bootstrap. It is shared between browser tabs and does not sync between devices.
Hover and focus previews never write storage. If saving fails, Settings remains
open with the draft and an error so the user can retry.

On first load, an account's v1 appearance migrates to v2. Old bundled ids that
also exist in the UIW catalog keep their selection using UIW's colors. Imported
themes and removed ids, including `texfolia` and `oneDark`, migrate to Follow
system appearance. PDF mode is preserved. The app no longer parses or imports
VS Code theme documents.

## Implementation and verification

[themes.ts](../apps/web/src/lib/themes.ts) builds the catalog from the package's
`defaultSettings*` exports and pairs each with its native theme extension. The
extension's CodeMirror dark-theme facet supplies its light or dark mode. Workspace
tokens derive from the settings' background, foreground, caret, and selection.
Supporting surfaces and borders mix foreground with background. Gutter border
shorthands supply a color when present; otherwise workspace borders use a mix.

[theme-editor.ts](../apps/web/src/lib/theme-editor.ts) uses the package's extension
directly. [LaTeX tags](../apps/web/src/lib/latex/tags.ts) inherit standard CodeMirror
highlight tags. There is no TextMate scope mapper.
[ThemeProvider](../apps/web/src/providers/theme-provider.tsx) applies workspace
variables and separates committed appearance, draft selection, and live preview.
The [bootstrap](../apps/web/src/lib/theme-bootstrap.ts) accepts cached colors only
for known v2 selections. Its constrained color grammar supports hex, numeric RGB
and RGBA, transparent, and the derived color mixes. Unknown properties are ignored
and unsafe snapshots fall back to the system theme.

The stylesheet and Dockview utility continue to consume the existing CSS variables.

Run unit checks and the browser test from the repository root:

```sh
bun test apps/web/src/lib/themes.test.ts
bun run --cwd apps/web test:themes
```

The browser test mounts the production workspace with an isolated network fixture
and needs no database. It covers editor and workspace preview, hover and focus
restoration, draft selection, Apply, Save, Cancel, tab closing, migration, reload,
and a narrow viewport.
