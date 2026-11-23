import type { RefObject } from "react";

import type { ShortcutAction } from "#/features/shortcuts/shortcuts";
import { useAppShortcut } from "#/providers/shortcuts-provider";

type WorkspaceShortcut = Extract<
  ShortcutAction,
  | "save"
  | "saveWithoutCompiling"
  | "compile"
  | "cleanBuild"
  | "nextTab"
  | "previousTab"
  | "projectSearch"
  | "sidebar"
  | "panel"
>;

/**
 * Binds the workspace's keyboard shortcuts to its container. Every shortcut
 * pauses while settings are open; a clean build also waits for a compile.
 */
export function useWorkspaceShortcuts(
  target: RefObject<HTMLElement | null>,
  {
    paused,
    compiling,
    actions,
  }: {
    paused: boolean;
    compiling: boolean;
    actions: Record<WorkspaceShortcut, () => void>;
  },
) {
  const options = { target, enabled: !paused };
  useAppShortcut("save", actions.save, options);
  useAppShortcut("saveWithoutCompiling", actions.saveWithoutCompiling, options);
  useAppShortcut("compile", actions.compile, options);
  useAppShortcut("cleanBuild", actions.cleanBuild, {
    target,
    enabled: !paused && !compiling,
  });
  useAppShortcut("nextTab", actions.nextTab, options);
  useAppShortcut("previousTab", actions.previousTab, options);
  useAppShortcut("projectSearch", actions.projectSearch, options);
  useAppShortcut("sidebar", actions.sidebar, options);
  useAppShortcut("panel", actions.panel, options);
}
