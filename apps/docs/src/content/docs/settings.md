---
title: Settings
---

Settings opens as a dialog inside a project. Outside the editor, Settings opens
`/settings/preferences`. The settings area contains Account, Preferences,
Connections, AI, Organizations, Billing, and Usage. `/billing` redirects to `/settings/billing`
and preserves the selected plan and organization.

## User preferences

The dialog's User tab and the Preferences page share the Appearance, Editor,
Spelling, and Keyboard shortcuts sections. Appearance previews across the app. Font size,
line wrapping, keymap, compile on save, and shortcut changes take effect after
saving, without a reload.

Compile after saving is on by default. With it on, Save and Mod+S save sources
and then run a cached compile. With it off, they only save. Save without
compiling, Save & compile, and Clean build stay available either way.

Apply saves changes and keeps the form open. Save saves changes and returns to
the workspace or projects. Cancel discards changes and restores the committed
theme. Closing a dirty dialog with Escape, its close button, or the backdrop
opens a confirmation dialog. Leaving a dirty Preferences page does the same.
Apply in that prompt saves changes and keeps Settings open. Discard leaves
without saving. Keep editing returns to the draft. Browser reloads and tab
closure use the browser's unsaved-changes prompt on Preferences.

Appearance uses `texfolia.appearance.v2:<userId>`. Editor preferences (including the keymap), compile preferences,
the personal dictionary, and the shortcut map use `texfolia.settings.v2:<userId>`. These are browser-local values,
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

Apply tries each changed storage owner in order: project formatting, project
spelling, main document, browser editor preferences, personal dictionary and shortcuts, then
appearance. A failed write does not block
the others. Successful writes remain committed, errors name the failed owner,
and the remaining draft can be retried. A failed Save never closes the form.
Browser preference load failures disable only the editor and shortcut fields.
Appearance and the project settings remain available.

When committed preferences or project formatting change outside Settings,
untouched draft fields follow the new values. Fields edited in the draft keep
their values. An immediate toolbar Wrap change cannot erase an unapplied font
size edit.

## Main document

The Project tab's Main document field sets `project.main_file`, described in
[Editor workspace](/editor-workspace/#main-document). `updateProjectMainFile`
uses the same write-access check as the other project settings. The file store
holds the saved value, because the file tree also changes it, so the settings
draft is empty until the field changes.

## Spelling

The Project tab's Spelling field sets the project's spell-check language. The
`project` table stores it in `spellcheck_language`, which defaults to `en-US`;
`off` turns checking off. `updateProjectSpelling` uses the same write-access
check as `updateProjectFormatting`, and Apply saves it as its own storage owner
after project formatting.

The User tab's Spelling section edits the personal dictionary, stored as
`spelling.words` in `texfolia.settings.v2:<userId>`. Changes there take effect
on Apply or Save. The editor's **Add to dictionary** saves immediately. See
[Spelling](/editor-workspace/#spelling).

## Keyboard shortcuts

`apps/app/src/lib/shortcuts/shortcuts.ts` owns the action catalog, default bindings,
validation, and conflict checks. Defaults copy VS Code unless that would take
over an important browser or editor function. The recorder accepts one chord or
up to four chords separated by spaces. Enter finishes recording. Escape cancels
it. Clear leaves an action unassigned. Reset restores one action, and Reset all
restores every default.

| Action                       | Default                     | VS Code equivalent                   |
| ---------------------------- | --------------------------- | ------------------------------------ |
| Settings                     | Mod+,                       | Preferences: Open Settings           |
| Keyboard shortcuts           | Mod+K Mod+S                 | Preferences: Open Keyboard Shortcuts |
| Save                         | Mod+S                       | File: Save                           |
| Save without compiling       | Mod+K S                     | File: Save without Formatting        |
| Save & compile               | Mod+Shift+B                 | Tasks: Run Build Task                |
| Clean build                  | Unassigned                  | None                                 |
| Format document              | Alt+Shift+F                 | Format Document                      |
| Open Markdown or SVG preview | Mod+Shift+V                 | Markdown: Open Preview               |
| Next / previous editor tab   | Ctrl+PageDown / Ctrl+PageUp | View: Open Next / Previous Editor    |
| Toggle sidebar               | Mod+Alt+B                   | View: Toggle Secondary Side Bar      |
| Toggle panel                 | Mod+J                       | View: Toggle Panel Visibility        |
| Go to file                   | Mod+P                       | Go to File                           |
| Command palette              | Mod+Shift+P                 | Show All Commands                    |
| Search projects              | Mod+P                       | Go to File                           |
| Search in project            | Mod+Shift+F                 | Search: Find in Files                |

Bold, Italic, Underline (Mod+B/I/U) and headings (Mod+Alt+0–6) keep the
standard rich-text bindings. New project keeps the N P sequence because the
browser reserves Mod+N.

An action can apply to one page: Search projects and New project to the dashboard,
and Go to file and Command palette to the workspace. Actions of different pages can
share a binding. Stored shortcuts gain new actions with their default binding, or
none when that would take over a binding already in use.

Bindings conflict when they match or when one is the prefix of another
sequence. Explicit Ctrl and Meta modifiers are checked against Mod on their
respective platforms. Unassigned actions never conflict. Conflicts prevent Apply
and Save.

The shortcut dispatcher uses the committed map. Sequences expire after one
second. In inputs, editable content, and CodeMirror, only bindings whose first
chord uses Mod, Ctrl, Meta, or Alt run, so Mod+S and Mod+K S work while typing
but N P does not. The editor keeps Mod+/ for toggling comments. Browser and editor
defaults for clipboard actions, selection, undo, redo, search, and Tab indentation
remain fixed.

## Vim and Emacs keymaps

The Editor section's Keymap field chooses Default, Vim, or Emacs. It is stored as
`editor.keymap` in `texfolia.settings.v2:<userId>` and defaults to Default for
existing preferences. `@replit/codemirror-vim` and `@replit/codemirror-emacs` load
as separate chunks the first time someone chooses them. Open editors switch
when the preference is saved. If a chunk fails to load, the editor shows an
error and keeps the default keys.

`apps/app/src/lib/editor/keymaps/keymaps.ts` lists the Ctrl and Alt chords each
keymap binds. Inside an editor running Vim or Emacs, an app shortcut whose
first chord is on that list gives the key to the editor. For example, Ctrl+B is
Vim's page up rather than Bold, and Emacs's Ctrl+K kills the line instead of
starting Mod+K sequences. Save, Save & compile, Clean build, and Next and
Previous editor tab never yield, so Mod+S saves on Windows and Linux even though Emacs
binds Ctrl+S.
Outside the editor, every shortcut keeps its binding. On macOS, Mod is Command,
which neither keymap uses, so only explicit Ctrl and Alt bindings yield. The
Keyboard shortcuts section marks each action that yields to the chosen keymap.

Vim's `u` and Ctrl+R and Emacs's undo keys use the editor's history, which is the
shared Yjs undo manager in collaborative files. Vim ex commands such as `:w` are
not connected to app actions.

The Emacs package marks its key registration `/*@__PURE__*/`, so bundlers drop
it. The Vite plugin in `apps/app/scripts/vite-emacs-keymap.ts` removes those
annotations in builds and in dev prebundling. Check it when you upgrade the package.

## Account pages

Account saves profile name and image through Better Auth. Changing email uses
Better Auth's email OTP flow.

Two-factor authentication uses authenticator-app TOTP codes and single-use
recovery backup codes. Users without a password (email OTP or OAuth) can enroll,
regenerate backup codes, and disable 2FA directly; users with a password must
confirm their current password. After enrollment, email OTP, OAuth, and password
sign-ins challenge for a TOTP or backup code unless the browser holds a valid
30-day trusted-device cookie.

Passkeys let signed-in users register, list, rename, and remove WebAuthn
credentials (Touch ID, Face ID, Windows Hello, or hardware security keys) scoped
to the app origin. Signing in with a passkey on `/login` (via Conditional UI
autofill or the passkey button) satisfies MFA directly without a second TOTP
prompt.

Account also lists active sessions, which can be signed out,
and **Download my data** exports it; see [Account export](#account-export).
Account deletion requires a confirmation email. It is refused while the account is
the only owner of an organization, or while its Pro subscription would renew. The
second check asks Stripe, so a subscription set to cancel does not block deletion.
Both checks run when the email is requested and again when its link is followed.

Connections lists linked GitHub, GitLab, Google, and Microsoft accounts. GitHub
and GitLab distinguish sign-in links from the repository scopes needed for Git.
**Reconnect** repeats the provider's authorization, for access that was revoked
there. **Disconnect** deletes the account and its tokens, and needs a sign-in from
the last 24 hours. Any account can be disconnected, because everyone can sign in
with an emailed code.

Organizations manages members, roles, teams, invitations, and the organization audit log. Owners and admins can browse the append-only audit log in **Settings → Organizations** (members without admin access cannot read it). It records organization renames, invitations (created, accepted, declined, canceled, and expired), member additions/removals/departures and role changes, team creation/updates/deletions and membership changes, organization billing events (plan starts, seat changes, cancellations, payment failures, and AI spend cap updates), and share-link and access changes on organization-owned projects. Secrets, access tokens, webhook secrets, and raw share tokens are never logged. See [Organizations](/project-controls/#organizations).

AI chooses the existing account-level preferred model for new conversations.
Usage shows monthly metered AI spend, reserved amounts, pending requests, and
the monthly cap. The model and cap save independently. Source storage totals
exclude deleted sources and compile artifacts. Compile counts cover the current
UTC month across accessible projects. The page uses stored data and does not
estimate physical R2 usage or compile CPU time.

Storage totals use binary units, and hovering shows the exact byte count.

## Account export

`GET /api/account/export` streams a ZIP:

| Path                 | Contents                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `account.json`       | Profile, connected accounts, sessions, organizations, AI settings and usage, project records, tags, comments |
| `ai-chats/<id>.json` | Each of the user's AI chats                                                                                  |
| `projects/<name>/…`  | Saved files of personal projects the user owns, including those in the trash                                 |
| `missing-files.txt`  | Present only when some files could not be read from storage                                                  |

It holds no credentials, OAuth tokens, or session tokens. Files of shared and
organization projects stay out. Chats in those projects keep only their text,
because tool calls and reasoning quote files. Unsaved edits are not included.

The account's records are read before the response starts. The rest is read while
the archive streams, over its own database connection, with one file in memory at
a time. Archives of more than 65,535 files or 4 GiB use ZIP64.

## Verification

`bun run --cwd apps/app test:settings` checks the project access gate, the account export, and Usage
queries against an isolated database named by `INTEGRATION_DATABASE_URL`.
`bun run --cwd apps/app test:editor-keymaps` checks Vim and Emacs in a browser:
switching without a reload, undo through Yjs, and shortcut yielding.
`bun run --cwd apps/app test:themes` checks drafts, theme preview, shortcut
recording, remapped editor actions, close guards, and responsive dialog layout.
The UI overhaul suite checks settings routes, Preferences navigation blocking,
billing redirects, and key sequences in the projects list.
