---
name: Texfolia editor
description: Zed agentic workspace with shadcn Nova controls and user-selected themes.
colors:
  background: "var(--background)"
  foreground: "var(--foreground)"
  primary: "var(--primary)"
  primary-foreground: "var(--primary-foreground)"
  secondary: "var(--secondary)"
  secondary-foreground: "var(--secondary-foreground)"
  muted: "var(--muted)"
  muted-foreground: "var(--muted-foreground)"
  accent: "var(--accent)"
  accent-foreground: "var(--accent-foreground)"
  destructive: "var(--destructive)"
  border: "var(--border)"
  input: "var(--input)"
  ring: "var(--ring)"
  card: "var(--card)"
  card-foreground: "var(--card-foreground)"
  popover: "var(--popover)"
  popover-foreground: "var(--popover-foreground)"
  sidebar: "var(--sidebar)"
  sidebar-foreground: "var(--sidebar-foreground)"
  sidebar-accent: "var(--sidebar-accent)"
  sidebar-accent-foreground: "var(--sidebar-accent-foreground)"
  sidebar-ring: "var(--sidebar-ring)"
  activity-background: "var(--activity-background)"
  activity-foreground: "var(--activity-foreground)"
  status-background: "var(--status-background)"
  status-foreground: "var(--status-foreground)"
  tab-header: "var(--tab-header)"
  tab-active-background: "var(--tab-active-background)"
  tab-active-foreground: "var(--tab-active-foreground)"
  tab-inactive-background: "var(--tab-inactive-background)"
  tab-inactive-foreground: "var(--tab-inactive-foreground)"
  tab-border: "var(--tab-border)"
typography:
  body:
    fontFamily: '"Geist Variable", sans-serif'
    fontSize: "0.875rem"
    lineHeight: "1.25rem"
  label:
    fontFamily: '"Geist Variable", sans-serif'
    fontSize: "0.75rem"
    lineHeight: "1rem"
    fontWeight: 500
  tab:
    fontFamily: '"Geist Variable", sans-serif'
    fontSize: "13px"
  file-row:
    fontFamily: '"Geist Variable", sans-serif'
    fontSize: "0.75rem"
    lineHeight: "1rem"
    fontWeight: 400
  code:
    fontFamily: "var(--font-mono)"
rounded:
  base: "0.625rem"
  sm: "calc(var(--radius) * 0.6)"
  md: "calc(var(--radius) * 0.8)"
  lg: "var(--radius)"
  xl: "calc(var(--radius) * 1.4)"
  file-row: "0px"
spacing:
  none: "0px"
  xs: "0.25rem"
  sm: "0.5rem"
  control-x: "0.625rem"
  md: "1rem"
  tree-level: "14px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0 0.625rem"
  button-ghost-xs:
    backgroundColor: "transparent"
    textColor: "inherit"
    rounded: "min(var(--radius-md), 10px)"
    height: "1.5rem"
    padding: "0 0.5rem"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0 0.625rem"
  input:
    backgroundColor: "transparent"
    textColor: "inherit"
    rounded: "{rounded.lg}"
    height: "2rem"
    padding: "0.25rem 0.625rem"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.xl}"
    padding: "1rem 0"
  file-row:
    backgroundColor: "transparent"
    textColor: "{colors.sidebar-foreground}"
    typography: "{typography.file-row}"
    rounded: "{rounded.file-row}"
    height: "24px"
    padding: "0"
  file-row-active:
    backgroundColor: "{colors.sidebar-accent}"
    textColor: "{colors.sidebar-accent-foreground}"
    rounded: "{rounded.file-row}"
    height: "24px"
  dock-tab-active:
    backgroundColor: "{colors.tab-active-background}"
    textColor: "{colors.tab-active-foreground}"
    typography: "{typography.tab}"
    height: "35px"
---

# Design System: Texfolia editor

## Overview

**Creative North Star: "Zed agentic workspace"**

The editor is a dense working environment for LaTeX sources, agents, and compiled output. Zed supplies the workspace arrangement. Existing shadcn Nova primitives supply the controls and their rounded shapes.

User-selected themes supply the appearance across the editor, sidebars, menus, tabs, and status bar. This record preserves that system and the user's confirmed layout. It applies to the authenticated web editor, not the marketing site.

**Key Characteristics:**

- A central dock with independently resizable working sidebars.
- Small ghost tools, with secondary actions in menus.
- Theme-driven surfaces, text, selection, and focus states.
- A compact, edge-to-edge file tree within the otherwise rounded Nova system.

## Colors

Semantic roles follow the selected theme; no fixed editor palette is prescribed.

### Primary

- **Primary action:** `primary` and `primary-foreground` distinguish explicit actions.
- **Selection:** `accent` and its foreground express selection in the workspace. Sidebar rows use their corresponding sidebar roles.
- **Destructive:** `destructive` identifies destructive actions and errors.

### Neutral

- **Workspace:** `background` and `foreground` provide the editing surface and text.
- **Supporting surfaces:** `muted`, `secondary`, `card`, `popover`, and `sidebar` carry their own foreground roles.
- **Chrome:** activity, status, and tab tokens distinguish persistent workspace regions and active files.
- **Boundaries and focus:** `border`, `input`, and `ring` retain the existing Nova treatments.

**The Theme Authority Rule.** Use semantic CSS variables. `#/features/editor/themes` derives workspace colors from the UIW CodeMirror theme catalog, and `src/providers/theme-provider.tsx` applies the resulting variables to the document root. `src/features/theme/theme-bootstrap.ts` supplies the initial appearance before paint. The values in `src/styles.css` are fallbacks, not a replacement palette. Frontmatter color values deliberately remain live variable references.

## Typography

Geist Variable supplies interface text and headings. The inherited Tailwind monospace stack supplies source text through `--font-mono`; editor preferences control its size. There is no separate display face in the editor.

Body controls use the body role. Panel headings and status controls use the label role. Dockview tabs use the tab role. File rows use the label size at regular weight, with medium weight for the active row. Preview tab titles are italic; pinned titles are upright.

## Layout

From left to right: separate chat history, Agents, central Dockview, and one right sidebar. Chat history starts hidden and opens from the bottom-left status button. Agents starts visible. File, Edit, and View menus sit above the workspace; the status bar sits below it.

The right sidebar switches among Files, Outline, Git, and Collaboration through bottom-right status icons or the View menu. It is one region, not parallel panels or an added activity rail. Git actions remain in the Git view.

Default widths are history (240px), Agents (320px), and right sidebar (288px), bounded by the existing resize range (240–600px). The menu header is (40px) high, the status bar (32px), other sidebar headers (36px), and dock tabs (35px). Source authority is `src/features/workspace/workspace-layout.ts` and `src/routes/project/$projectId/-components/project-workspace.tsx`.

Below the existing medium breakpoint (48rem), opening a sidebar closes the others; the sidebars overlay the dock and are capped at (85%) of its width. Layout preferences remain scoped to each user and project.

**The Files Only Rule.** Files contains only the folder and file tree. It has no Files heading, toolbar, export footer, outer padding, or row margins. Rows are (24px) high. Indentation expresses hierarchy in (14px) steps, with the existing file-icon alignment offset.

## Elevation & Depth

Workspace regions use theme surfaces and thin boundaries. Nova cards and dialogs retain their subtle foreground rings; popup menus retain the library's medium shadow. Dialogs and menus use the existing short fade and zoom transitions (100ms). The dock does not acquire decorative cards, shadows, or floating chrome.

## Shapes

The existing base radius and derived Nova radii in `src/styles.css` remain authoritative. Buttons and inputs use the large radius, compact tools use their capped medium radius, and cards and dialogs use the extra-large radius.

**The Scoped Tree Rule.** Only Files tree rows lose rounding and padding. Keep the existing `SidebarMenu`, `SidebarMenuItem`, and `SidebarMenuButton` primitives, with scoped `rounded-none p-0` overrides and the explicit row height. Nova rounding remains everywhere else, including file-action dialogs and context menus.

## Components

### Buttons

Panel tools use small ghost buttons, usually the extra-small icon size (24px). Keep the visible set small and put secondary actions in overflow menus. Explicit dialog actions retain primary or outline variants. Nova hover surfaces, visible focus rings, disabled opacity, and invalid states remain intact.

### Inputs and containers

Inputs retain Nova borders, padding, rounding, and focus rings. Dialogs reuse the existing create, upload, export, and source-path repair flows. Cards retain their normal Nova surface and spacing where already used; they do not wrap dock panels.

### Navigation

File, Edit, and View use the existing menubar. Sidebar switches live in the bottom-right status area, with visible pressed states and accessible names. Files operations open through the File menu and applicable context menus. The Files view itself remains the tree alone.

### File tree

`src/routes/project/$projectId/-components/project-file-tree.tsx` composes Nova SidebarMenu primitives. Folder chevrons, type icons, truncation, selection, hover, focus, and disabled states remain available. Generated files appear under an ordinary `out` folder and are read-only. Preserve permission-aware context actions and the existing dialogs.

### Dock tabs and PDF

Settings opens as a standard dialog with a dimmed backdrop, User and Project tabs, and outlined settings items. The User tab and the Preferences page share their section controls. The theme list previews on hover and keyboard focus. Apply commits the draft while keeping Settings open; Save commits and closes; Cancel discards. Closing a dirty draft opens a confirmation prompt. Project formatting is shared on the server. User preferences and programmable shortcuts remain local to each account in this browser.

Source files and generated files share preview and pin semantics. A single click opens an italic preview; the next preview replaces it. Double-clicking, editing a source, or choosing **Keep open** pins the tab. PDF viewers open on demand as ordinary file tabs. There is no permanent PDF split or empty PDF panel. Problems remains a dock panel.

The functional reference is [Editor workspace](../docs/src/content/docs/editor-workspace.md). Component authority is `components.json` (`base-nova`, zinc base, CSS variables, Tabler icons) and the primitives in [`packages/ui`](../../packages/ui/README.md).

## Do's and Don'ts

### Do:

- **Do** bind editor colors to the existing semantic theme variables.
- **Do** keep chat history separate from Agents and hidden by default.
- **Do** use one right sidebar switched by the bottom-right icons.
- **Do** keep Files edge-to-edge with 24px Nova SidebarMenu rows and hierarchy indentation only.
- **Do** reuse existing File menu, context menu, and dialog flows for file operations.
- **Do** retain Nova rounding outside the scoped file tree.

### Don't:

- **Don't** add a Files heading, toolbar, export footer, outer padding, or rounded file rows.
- **Don't** add a permanent PDF split or open an empty PDF viewer.
- **Don't** replace the selected theme with fixed editor colors or a new palette.
- **Don't** crowd panel headers with secondary action buttons.
