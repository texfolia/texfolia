import type { DockviewApi } from "dockview-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";

import { useStableCallback } from "#/hooks/use-stable-callback";
import { documentCachingStopped } from "#/lib/collaboration/browser";
import { debounce } from "#/lib/debounce";
import {
  defaultWorkspaceChrome,
  readWorkspaceLayout,
  writeWorkspaceLayout,
  type PanelView,
  type WorkspaceChrome,
} from "#/lib/workspace/workspace-layout";

const narrowQuery = "(max-width: 767px)";
// Dragging a divider changes the layout on every frame.
const persistDelayMs = 200;

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

  const updateChrome = useCallback(
    (
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
      ),
    [],
  );

  // Status-bar buttons toggle their own view; the menu always shows it.
  const togglePanel = useCallback(
    (view?: PanelView) =>
      updateChrome((current) =>
        !view
          ? { panelOpen: !current.panelOpen }
          : current.panelOpen && current.panelView === view
            ? { panelOpen: false }
            : { panelOpen: true, panelView: view },
      ),
    [updateChrome],
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

  const writeLayout = useStableCallback(() => {
    if (documentCachingStopped()) return;
    const api = dock.current;
    if (api) writeWorkspaceLayout(layoutKey, chrome, api.toJSON());
  });
  const [persist] = useState(() => debounce(writeLayout, persistDelayMs));
  useEffect(() => {
    if (ready) persist.schedule();
  }, [chrome, ready, persist]);
  // A layout effect's cleanup, so the dock is still there when leaving.
  useLayoutEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") persist.flush();
    };
    window.addEventListener("pagehide", persist.flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", persist.flush);
      document.removeEventListener("visibilitychange", hidden);
      persist.flush();
    };
  }, [persist]);

  return {
    chrome,
    updateChrome,
    togglePanel,
    /** Writes the chrome and dock layout soon; call on dock layout changes. */
    persistLayout: persist.schedule,
    initialDock: initialLayout.dock,
  };
}
