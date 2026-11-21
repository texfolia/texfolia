# Texfolia

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Texfolia is the AI-native LaTeX workspace. People edit project sources, collaborate, compile and inspect PDFs, and ask an assistant to work on their project.

## Capabilities and Constraints

NAT-314 establishes the editor workspace: agents on the left, a central dock for files and Problems, a separate usually hidden chat-history sidebar on the far left, and one right sidebar switching Files, Outline, Git and Collaboration through bottom-right icons, a top menu and bottom status bar. Git is optional. Generated output is read-only, presented within the ordinary file tree. Layout preferences belong to each user and project; assistant threads belong to each user and project on the server.

Existing compilation, collaboration permissions, assistant tools and metering, and themes remain authoritative. Settings opens as an editor dialog with User and Project tabs, drafts, and Apply, Save, and Cancel controls. Outside the editor, the settings pages share the User controls. File opening follows preview and pin semantics. The user confirmed File, Edit and View menus; Git actions stay in the Git sidebar.

## Brand Commitments

The editor follows Zed’s agentic layout and the existing theme tokens. The component style is shadcn Nova. Panel tools are small ghost buttons with secondary actions in menus. PDF viewers open as ordinary file tabs when a source or generated PDF is selected; there is no permanently open or empty PDF split.

The Files view contains only the folder and file tree. Its rows are square and flush to the panel edges, without surrounding padding or a toolbar. Other UI elements keep the Nova component styling.
