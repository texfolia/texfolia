# Settings

Settings opens as a dialog inside a project. Outside the editor, Settings opens
`/settings/preferences`. The settings area contains Account, Preferences,
Connections, AI, Billing, and Usage. `/billing` redirects to `/settings/billing`
and preserves the selected plan and organization.

## User preferences

The dialog's User tab and the Preferences page share the Appearance, Editor,
and Keyboard shortcuts sections. Appearance previews across the app. Font size,
line wrapping, and shortcut changes take effect after saving.

Apply saves changes and keeps the form open. Save saves changes and returns to
the workspace or projects. Cancel discards changes and restores the committed
theme. Closing a dirty dialog with Escape, its close button, or the backdrop
opens a confirmation dialog. Leaving a dirty Preferences page does the same.
Apply in that prompt saves changes and keeps Settings open. Discard leaves
without saving. Keep editing returns to the draft. Browser reloads and tab
closure use the browser's unsaved-changes prompt on Preferences.

Appearance uses `texfolia.appearance.v2:<userId>`. Editor preferences and the
shortcut map use `texfolia.settings.v2:<userId>`. These are browser-local values,
with no account sync. The old browser editor preference migrates on first use.
The editor toolbar's Wrap lines control and the PDF viewer's match-theme control
continue to save immediately.

## Project formatting

The dialog's Project tab contains indentation, long-line wrapping, and maximum
line width. The `project` table stores `format_indent`, `format_wrap`, and
`format_width`. Existing and new projects start at 2 spaces, wrapping enabled,
and 80 columns. Old browser formatting preferences are not copied to projects.

`updateProjectFormatting` validates the request and calls `lockProject` with
write access in the update transaction. Personal owners, organization members,
and editor collaborators can save. Viewers can read the settings. The project
loader returns the committed formatting, which the editor uses for indentation
and Format document. Collaborators see changes when they reload the project.

Apply tries each changed storage owner in order: project formatting, browser
editor preferences and shortcuts, then appearance. A failed write does not block
the others. Successful writes remain committed, errors name the failed owner,
and the remaining draft can be retried. A failed Save never closes the form.
Browser preference load failures disable only the editor and shortcut fields.
Appearance and project formatting remain available.

When committed preferences or project formatting change outside Settings,
untouched draft fields follow the new values. Fields edited in the draft keep
their values. An immediate toolbar Wrap change cannot erase an unapplied font
size edit.

## Keyboard shortcuts

`apps/web/src/lib/shortcuts.ts` owns the action catalog, default bindings,
validation, and conflict checks. The recorder accepts one chord or up to four
chords separated by spaces. Enter finishes recording. Escape cancels it.
Reset restores one action, and Reset all restores every default.

Bindings conflict when they match or when one is the prefix of another
sequence. Explicit Ctrl and Meta modifiers are checked against Mod on their
respective platforms. Conflicts prevent Apply and Save. Bold defaults to Mod+B,
and Toggle sidebar defaults to Mod+Shift+B.

The shortcut dispatcher uses the committed map. Sequences expire after one
second and are ignored in inputs, editable content, and CodeMirror. Modifier
chords for actions such as saving still work while typing. Browser and editor
defaults for clipboard actions, selection, undo, redo, search, and Tab indentation
remain fixed.

## Account pages

Account saves profile name and image through Better Auth. Changing email uses
Better Auth's email OTP flow. Account deletion requires a confirmation email.
Connections lists linked GitHub, GitLab, Google, and Microsoft accounts. GitHub
and GitLab distinguish sign-in links from the repository scopes needed for Git.

AI chooses the existing account-level preferred model for new conversations.
Usage shows monthly metered AI spend, reserved amounts, pending requests, and
the monthly cap. The model and cap save independently. Source storage totals
exclude deleted sources and compile artifacts. Compile counts cover the current
UTC month across accessible projects. The page uses stored data and does not
estimate physical R2 usage or compile CPU time.

## Verification

`bun run --cwd apps/web test:settings` checks the project access gate and Usage
queries against an isolated database named by `INTEGRATION_DATABASE_URL`.
`bun run --cwd apps/web test:themes` checks drafts, theme preview, shortcut
recording, remapped editor actions, close guards, and responsive dialog layout.
The UI overhaul suite checks settings routes, Preferences navigation blocking,
billing redirects, and key sequences in the projects list.
