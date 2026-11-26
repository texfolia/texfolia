---
title: Editor workspace
---

The workspace has File, Edit and View menus above the dock, an Agents sidebar on
the left, one switchable sidebar on the right, and a status bar below. Use the
bottom-right icons or View menu to switch Files, Outline, Search, Git, Comments
or Collaboration.
Git actions stay in the Git view. Settings opens as a dialog with User and Project tabs. Changes use Apply, Save, and Cancel. Closing a dirty draft prompts before discarding. See [Settings](/settings/).

The status bar shows Problems, compile logs, compile state, the main document's
word count, live collaborators, the scratchpad, the git branch when a repository
exists, and the active file and the editor’s line and column.
The Comments button shows how many threads are unresolved. The collaborators menu
lists who is online and the file each person has active. Choosing a person opens that
file, and following them keeps opening the file they move to.
Compile state also starts a build. PDF files open as ordinary preview tabs when
selected in the Files tree; no empty PDF viewer opens with the workspace.

Only visible editor tabs keep a live editor. A hidden tab unmounts its editor
and keeps its selection, scroll position and undo history, so switching back
restores them. Edits made by collaborators while the tab is hidden still merge.

## Main document

A project compiles its main document. Choose it with **Set as main document** in a
`.tex` file's context menu in Files, the command palette, or Settings → Project.
A star marks it in Files. The choice is the `project.main_file` path, shared with
collaborators on their next metadata sync. Renaming or moving the file or its folder
updates the path in the same transaction. Deleting the file keeps the path, so the
choice returns when a file comes back there, as after a Git branch switch.

Without a choice, or while its file is missing, the main document is `main.tex`,
else the first `.tex` file, outermost folders first (`projectMainFile` in
`#/lib/projects`). Share links open it first, duplicates keep it, and
the assistant's `compile` tool uses it by default.

## Go to file and the command palette

**Go to file** (Mod+P) finds project and build files by fuzzy match. Files used last
come first, and the current file last. End the query with `:12` or `:12:3` to open
a line and column. A query that starts with `>` searches the workspace's commands
instead, as does the **Command palette** (Mod+Shift+P). Firefox keeps
Ctrl+Shift+P for private windows, so use Mod+P and `>`, the View menu, or another
binding there. File, Edit, and View show each item's current shortcut.

## Previews

Images (PNG, JPG, GIF, WebP, AVIF, BMP, ICO, and SVG) show their dimensions over a
grid that reveals transparency, with zoom presets, Ctrl/Cmd + scroll, and fit. SVG
uploads are text, so they open as source and **Open image preview** shows the live
image beside it. Share links use the same previews.

PDFs scroll through all of their pages; only those near the viewport are drawn.
Zoom has fit to width, fit to page, presets, and Ctrl/Cmd + scroll around the pointer.
**Find in PDF** (Mod+F while the PDF has focus) ignores case, line breaks, and
hyphenation. **Print** draws each page as an image into a hidden frame, because the
security policy allows no PDF plugin. Protected PDFs ask for their password in a
dialog.

A new build loads behind the PDF on screen and replaces it once its visible pages
are drawn. The page, scroll position, zoom, and rotation stay. Hiding the tab keeps
them too.

## Spelling

LaTeX documents (`.tex` and `.ltx`) are spell checked as you type. Misspelled
words get a wavy underline. Hover one for up to five suggestions and **Add to
dictionary**. Spelling stays in the editor and is not listed in Problems.

Only prose is checked. Commands, environment names, math, comments, verbatim
material, `\label`, `\ref` and `\cite` keys, file, unit and glossary arguments,
and the preamble (except `\title`) are skipped. The checker reuses the word
counter's parser; see `apps/app/src/lib/editor/spelling/prose.ts`. Hyphenated words are
checked part by part, accent commands such as `caf\'e` are read as the letters
they typeset, and acronyms, numbers and single letters are skipped. Package and
class files are not checked.

Each project picks its language in Settings → Project → Spelling: English (US),
the default, English (UK), French, German, Spanish, or Off. Checking runs in a
Web Worker with [nspell](https://github.com/wooorm/nspell), a Hunspell-compatible
checker, and the `dictionary-*` Hunspell dictionaries. `bun run spelling:assets`
copies them into `public/dictionaries` before dev and build (0.5–1.4 MB each).
A dictionary is fetched only when a project uses it and stays loaded for the
tab. Its URL has the package version, so browsers can keep it forever. nspell does not support Hunspell compound rules, so some German compounds
are flagged.

The personal dictionary is in Settings → User → Spelling, where you can add or
remove words. It applies to every project and language and is stored with the
other browser-local preferences. Lowercase entries also accept capitalized
forms. **Add to dictionary** saves immediately, including for viewers.

`bun run --cwd apps/app test:spelling` checks the worker, dictionary loading,
suggestions and the personal dictionary in Chromium.

## Asking the assistant

**Ask AI about selection**, in the editor's context and overflow menus, quotes the
selection, or the cursor's line, in the assistant's message. Nothing is sent until
you send it. See [the assistant guide](/ai-assistant/).

`bun run --cwd apps/app test:editor-features` checks the main document, go to file,
previews, and the assistant's changes in Chromium.

## Bottom panel

Problems, Logs, and Terminal share a bottom panel below the dock. It is closed by default
and opens only when you choose it: View > Panel, Problems, Logs, or Terminal, the
status-bar Problems and logs buttons, or Mod+J. A failed compile does not open it. Drag the
divider or use its arrow keys to resize it; Home and End choose its smallest and largest size.
The sidebars' dividers work the same way.

Problems lists browser diagnostics and parsed compile-log diagnostics. Selecting
a problem pins its file and jumps to the reported line. **Fix with AI** writes the
problem into the assistant's message for you to send; it is also a quick fix in the
editor.

Logs lists the `compileHistoryLimit` (10) most recent compiles of the project and
shows the selected compile’s timeline and raw TeX log. Times are shown in your
local time with the time zone labeled. Received, accepted, started, first PDF
byte, LaTeX finished and published are server instants. Sent, first browser
byte, notified and rendered are measured in the browser with `performance.now()`
and placed on server time from the submission round trip, marked with ≈. The
browser’s wall clock is never used. The timeline shows the coordinator’s 300 ms
debounce as a debounce, and names the overflow queue only when that path ran.
The container row distinguishes a cold start, with or without a restored cache,
from a warm or editor-prewarmed container. LaTeX run duration is positioned from
engine durations, so it has no clock time of its own. Logs never shows usage or
fair-use limits. Project members and full-project share links can read logs and
timelines; PDF-only links cannot.

Terminal is a placeholder that points to Logs. Texfolia offers no shell.

Files shows only folders and files, with compact square rows flush to the panel
edges. Create, upload, export and path repair open from the File menu; row
context menus provide the existing file and folder actions.

Dragging a row onto a folder, or onto a file in that folder, moves it there
through the same rename call as **Move**, so collaborators see it on their next
metadata sync. Files and folders dropped from the desktop upload into the
target folder; dropped folders merge into existing folders of the same name.
Every path and the 10 MiB per-file limit are checked before anything is stored,
so a rejected drop changes nothing. `out/` accepts no drops, and name conflicts
show the usual error. The context menu's **Move** and **Upload** remain the
keyboard alternatives.

Single-clicking a source or an `out` file opens an italic preview tab. The next
preview replaces it. Double-clicking a row or tab, editing a source, or choosing
**Keep open** pins it. Opening an existing file focuses its tab. Tab context menus
close one tab, other tabs, all tabs, or tabs to the right in the same group. Edits
remain in the existing collaboration and draft storage when a tab closes.

Signing out warns that unsynced edits will be discarded, then removes the
current user's `texfolia.yjs.<userId>.*` IndexedDB databases from this browser.
It also removes legacy `texfolia.project.<projectId>.sources` recovery drafts,
which are shared across accounts, and the current user's workspace layouts,
which can contain Markdown preview text.
Open editors using those databases close and return to the home page. Cancel
sign-out and reconnect to save offline edits first. Saved documents synchronize
again after sign-in. Appearance and editor preferences remain. If deletion is
blocked, sign-out shows a retryable error after ending the server session.
Close other Texfolia tabs and retry, or clear Texfolia's site data if the browser
cannot remove the databases. Account deletion is a separate email-confirmed
flow and does not invoke this client cleanup.

Generated files appear under an ordinary `out` folder within the project tree.
They remain read-only build artifacts and support open and download. Source
files, folders, the editor, tabs, git changes and collaborators have context
menus that reuse the existing actions and permissions.

Outline shows section headings from the main document, following `\input` and
`\include` in document order. It nests `part`, `chapter`, `section`, `subsection`,
`subsubsection`, `paragraph` and `subparagraph`, ignores comments and verbatim
material, and guards include cycles. Selecting a heading pins its source and
jumps to its line.

Search finds literal text across every text file in the project, including
unsaved collaborative edits, so it matches what open editors show. Binary files
are skipped. Results list each path with line numbers and a highlighted excerpt;
selecting one pins its file and selects the match. Enter opens the first result.
Match case is off by default, and results stop at 1,000 matches. Open it with
Edit > Search in project or Mod+Shift+F, which also seeds the query from a
single-line editor selection. Viewers can search; editing still follows file
permissions. Find in the Edit menu still searches only the active file.

Comments lists review comment threads anchored to source ranges. Add one from the
editor toolbar or context menu; commented ranges are highlighted and marked in the
gutter. See [Review comments](/project-controls/#review-comments).

**Scratchpad** in the status bar or View menu opens the project's shared Markdown
notes as a tab. It edits like a Markdown file, with live cursors and the same
preview (Mod+Shift+V), and saves itself. See
[Scratchpad](/project-controls/#scratchpad).

Chat history is a separate sidebar to the left of Agents, hidden by default.
The bottom-left history button opens it without embedding a thread list above
the conversation. History and Agents can be resized independently.

Sidebar visibility, widths, the right view, the bottom panel’s state and
Dockview’s serialized layout are
stored under `texfolia.workspace.layout.v1:<userId>:<projectId>` in localStorage.
Drag the dividers or use their arrow keys to resize. On narrow screens only one
sidebar opens at a time, and PDFs follow the same tab placement as other files.
Invalid layout data falls back to the default arrangement. Browser storage
failure does not prevent editing. Chat history is stored on the server; see
[the assistant guide](/ai-assistant/). Git is optional; see
[Git integration](/git-integration/).

The app uses shadcn’s `base-nova` component style. Panel headers use small ghost
buttons. Editor and PDF secondary tools live in an overflow menu to keep the
working area clear.
