import type { DockviewApi } from "dockview-react";
import { type RefObject, useEffect, useEffectEvent, useState } from "react";

import { documentCachingStopped } from "#/lib/collaboration/cache";
import {
  defaultWorkspaceChrome,
  readWorkspaceLayout,
  writeWorkspaceLayout,
  type PanelView,
  type WorkspaceChrome,
} from "#/lib/workspace-layout";

const narrowQuery = "(max-width: 767px)";

/** On narrow screens only one sidebar overlays the editor at a time. */
export function applyChromePatch(
  previous: WorkspaceChrome,
  patch: Partial<WorkspaceChrome>,
  narrow: boolean,
): WorkspaceChrome {
  const next = { ...previous, ...patch };
  if (!narrow) return next;
  if (patch.historyOpen === true) {
    next.rightOpen = false;
    next.agentsOpen = false;
  } else if (patch.agentsOpen === true) {
    next.rightOpen = false;
    next.historyOpen = false;
  } else if (patch.rightOpen === true) {
    next.agentsOpen = false;
    next.historyOpen = false;
  }
  return next;
}

/**
 * The sidebars and bottom panel around the dock, persisted per user and
 * project together with the dock layout.
 */
export function useWorkspaceChrome({
  layoutKey,
  dock,
  ready,
}: {
  layoutKey: string;
  dock: RefObject<DockviewApi | null>;
  ready: boolean;
}) {
  const [initialLayout] = useState(() => {
    try {
      return readWorkspaceLayout(localStorage.getItem(layoutKey));
    } catch {
      return { chrome: defaultWorkspaceChrome, dock: undefined };
    }
  });
  const [chrome, setChrome] = useState(initialLayout.chrome);

  const updateChrome = (
    patch:
      | Partial<WorkspaceChrome>
      | ((previous: WorkspaceChrome) => Partial<WorkspaceChrome>),
  ) =>
    setChrome((previous) =>
      applyChromePatch(
        previous,
        typeof patch === "function" ? patch(previous) : patch,
        window.matchMedia(narrowQuery).matches,
      ),
    );

  // Status-bar buttons toggle their own view; the menu always shows it.
  const togglePanel = (view?: PanelView) =>
    updateChrome((current) =>
      !view
        ? { panelOpen: !current.panelOpen }
        : current.panelOpen && current.panelView === view
          ? { panelOpen: false }
          : { panelOpen: true, panelView: view },
    );

  useEffect(() => {
    const narrow = window.matchMedia(narrowQuery);
    const adapt = () => {
      if (narrow.matches)
        setChrome((previous) =>
          (previous.agentsOpen || previous.historyOpen) && previous.rightOpen
            ? { ...previous, agentsOpen: false, historyOpen: false }
            : previous.agentsOpen && previous.historyOpen
              ? { ...previous, historyOpen: false }
              : previous,
        );
    };
    adapt();
    narrow.addEventListener("change", adapt);
    return () => narrow.removeEventListener("change", adapt);
  }, []);

  /** Writes the chrome and dock layout; also called on dock layout changes. */
  const persistLayout = useEffectEvent(() => {
    if (documentCachingStopped()) return;
    const api = dock.current;
    if (api) writeWorkspaceLayout(layoutKey, chrome, api.toJSON());
  });
  useEffect(() => {
    if (ready) persistLayout();
  }, [chrome, ready]);

  return {
    chrome,
    updateChrome,
    togglePanel,
    persistLayout,
    initialDock: initialLayout.dock,
  };
}
