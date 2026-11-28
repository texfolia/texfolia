import type { ComponentProps } from "react";

import { lazyPanel } from "#/components/lazy-panel";
import { useHasBeen } from "#/hooks/use-has-been";

import type { usePalette } from "../-hooks/use-palette";
import type { useReferences } from "../-hooks/use-references";
import type { AddReferenceDialog as AddReference } from "./add-reference-dialog";
import type { WorkspaceCommand } from "./workspace-palette";

const SettingsDialog = lazyPanel("Settings", async () => {
  const { SettingsDialog } =
    await import("#/components/settings/settings-dialog");
  return SettingsDialog;
});
const AddReferenceDialog = lazyPanel("Add reference", async () => {
  const { AddReferenceDialog } = await import("./add-reference-dialog");
  return AddReferenceDialog;
});
const WorkspacePalette = lazyPanel("Go to file", async () => {
  const { WorkspacePalette } = await import("./workspace-palette");
  return WorkspacePalette;
});

/** The workspace's dialogs. Each loads when it first opens. */
export function WorkspaceDialogs({
  settingsOpen,
  references,
  knownKeys,
  palette,
  commands,
}: {
  settingsOpen: boolean;
  references: ReturnType<typeof useReferences>;
  knownKeys: ComponentProps<typeof AddReference>["knownKeys"];
  palette: ReturnType<typeof usePalette>;
  commands: () => WorkspaceCommand[];
}) {
  // They stay mounted once used, so that they can animate closed.
  const settingsUsed = useHasBeen(settingsOpen);
  const referencesUsed = useHasBeen(!!references.request);
  const paletteUsed = useHasBeen(!!palette.request);
  return (
    <>
      {settingsUsed && <SettingsDialog />}
      {referencesUsed && (
        <AddReferenceDialog
          request={references.request}
          onClose={references.close}
          bibFiles={references.bibFiles}
          knownKeys={knownKeys}
          readBib={references.readBib}
          appendBib={references.appendBib}
          createBib={references.createBib}
        />
      )}
      {paletteUsed && (
        <WorkspacePalette
          request={palette.request}
          files={palette.files}
          commands={commands}
          onClose={palette.close}
        />
      )}
    </>
  );
}
