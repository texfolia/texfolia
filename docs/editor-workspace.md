# Editor workspace

The workspace has File, Edit and View menus above the dock, an Agents sidebar on
the left, one switchable sidebar on the right, and a status bar below. Use the
bottom-right icons or View menu to switch Files, Outline, Git or Collaboration.
Git actions stay in the Git view. Settings opens the existing editor dialog.

The status bar shows compile state, Problems, live collaborators, the git branch
when a repository exists, and the active editor’s line and column. Compile state
also starts a build. Problems opens as a dock panel. PDF files open as ordinary
preview tabs when selected in the Files tree; no empty PDF viewer opens with the
workspace. Selecting a problem pins its file and jumps to the reported line.

Files shows only folders and files, with compact square rows flush to the panel
edges. Create, upload, export and path repair open from the File menu; row
context menus provide the existing file and folder actions.

Single-clicking a source or an `out` file opens an italic preview tab. The next
preview replaces it. Double-clicking a row or tab, editing a source, or choosing
**Keep open** pins it. Opening an existing file focuses its tab. Tab context menus
close one tab, other tabs, all tabs, or tabs to the right in the same group. Edits
remain in the existing collaboration and draft storage when a tab closes.

Generated files appear under an ordinary `out` folder within the project tree.
They remain read-only build artifacts and support open and download. Source
files, folders, the editor, tabs, git changes and collaborators have context
menus that reuse the existing actions and permissions.

Outline shows section headings from the main document, following `\input` and
`\include` in document order. It nests `part`, `chapter`, `section`, `subsection`,
`subsubsection`, `paragraph` and `subparagraph`, ignores comments and verbatim
material, and guards include cycles. Selecting a heading pins its source and
jumps to its line.

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
