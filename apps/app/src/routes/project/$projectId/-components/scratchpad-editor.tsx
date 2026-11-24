import type { IDockviewPanelProps } from "dockview-react";

import { scratchpadId } from "#/lib/collaboration";
import { useWorkspace } from "#/providers/workspace-provider";

import { scratchpadTitle } from "../-hooks/use-dock-panels";
import { DocumentEditor } from "./document-editor";

/** The project's shared Markdown notes, which are not a project file. */
export function ScratchpadEditor({ api }: IDockviewPanelProps) {
  const workspace = useWorkspace();
  const { scratchpad } = workspace;
  return (
    <DocumentEditor
      id={scratchpadId}
      panelApi={api}
      collaboration={scratchpad}
      // The server decides, because draft recovery only pauses source edits.
      canWrite
      // Names the language and the downloaded copy.
      filename="scratchpad.md"
      labels={{
        title: scratchpadTitle,
        region: "Scratchpad editor",
        source: "Scratchpad",
        placeholder: scratchpad?.getStatus().canWrite
          ? "Shared Markdown notes for this project…"
          : "No notes yet.",
      }}
      autosaved
      allowOpenFile={false}
      formatSettings={workspace.formatSettings}
      onOpenPreview={() => workspace.openMarkdownPreview(scratchpadId)}
    />
  );
}
