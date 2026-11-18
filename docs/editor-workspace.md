# Editor workspace

The workspace has File, Edit and View menus above the dock, an Agents sidebar on
the left, one switchable sidebar on the right, and a status bar below. Use the
bottom-right icons or View menu to switch Files, Outline, Search, Git or
Collaboration.
Git actions stay in the Git view. Settings opens as a dialog with User and Project tabs. Changes use Apply, Save, and Cancel. Closing a dirty draft prompts before discarding. See [Settings](settings.md).

The status bar shows compile state, Problems, live collaborators, the git branch
when a repository exists, and the active editor’s line and column. Compile state
also starts a build. Problems opens as a dock panel. PDF files open as ordinary
preview tabs when selected in the Files tree; no empty PDF viewer opens with the
workspace. Selecting a problem pins its file and jumps to the reported line.

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

Chat history is a separate sidebar to the left of Agents, hidden by default.
The bottom-left history button opens it without embedding a thread list above
the conversation. History and Agents can be resized independently.

Sidebar visibility, widths, the right view and Dockview’s serialized layout are
stored under `texfolia.workspace.layout.v1:<userId>:<projectId>` in localStorage.
Drag the dividers or use their arrow keys to resize. On narrow screens only one
sidebar opens at a time, and PDFs follow the same tab placement as other files.
Invalid layout data falls back to the default arrangement. Browser storage
failure does not prevent editing. Chat history is stored on the server; see
[the assistant guide](ai-assistant.md). Git is optional; see
[Git integration](git-integration.md).

The app uses shadcn’s `base-nova` component style. Panel headers use small ghost
buttons. Editor and PDF secondary tools live in an overflow menu to keep the
working area clear.
