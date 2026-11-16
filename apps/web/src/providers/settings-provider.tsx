import { useLiveQuery } from "@tanstack/react-db";
import { useHotkeys } from "@tanstack/react-hotkeys";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import { createBrowserSettingsStore } from "#/lib/settings.functions";
import { defaultSettings, type Settings } from "#/lib/settings.schema";
import { useTheme } from "#/providers/theme-provider";
export type SettingsSection =
  | "Appearance"
  | "Editor"
  | "Formatting"
  | "Keyboard shortcuts";

function useSettingsState() {
  const [store] = useState(() => createBrowserSettingsStore(window));
  const [ready, setReady] = useState(false);
  const { data } = useLiveQuery({
    query: (q) =>
      ready ? q.from({ preferences: store.preferences }) : undefined,
  });
  const preferences = data?.[0] ?? defaultSettings;
  const [error, setError] = useState<string | null>(null);
  const [open, setOpenState] = useState(false);
  const [openRequest, setOpenRequest] = useState(0);
  const [closeGuard, setCloseGuard] = useState(false);
  const theme = useTheme();
  function setOpen(next: boolean) {
    if (next) {
      setOpenRequest((current) => current + 1);
      if (!open) theme.beginDraft();
      setOpenState(true);
    } else if (theme.dirty) {
      setCloseGuard(true);
    } else {
      theme.discardDraft();
      setOpenState(false);
    }
  }
  function discard() {
    theme.discardDraft();
    setCloseGuard(false);
    setOpenState(false);
  }
  function apply(close = false) {
    if (!theme.commitDraft()) return;
    setCloseGuard(false);
    if (close) {
      theme.discardDraft();
      setOpenState(false);
    }
  }
  const [section, setSection] = useState<SettingsSection>("Appearance");

  useEffect(() => {
    let active = true;
    void store
      .initialize()
      .then(() => {
        if (active) setReady(true);
      })
      .catch(() => {
        if (active)
          setError(
            "Preferences could not be loaded. Check browser storage and reload to try again.",
          );
      });
    return () => {
      active = false;
      void store.preferences.cleanup({ dependents: true });
    };
  }, [store]);

  function persist(operation: () => Promise<void>) {
    setError(null);
    void operation().catch(() =>
      setError(
        "Your preference could not be saved. Check browser storage and try again.",
      ),
    );
  }

  useHotkeys(
    [
      { hotkey: "Mod+,", callback: () => setOpen(true) },
      {
        hotkey: "Mod+/",
        callback: () => {
          setSection("Keyboard shortcuts");
          setOpen(true);
        },
      },
    ],
    { ignoreInputs: false, capture: true },
  );

  return {
    editor: preferences.editor,
    updateEditor: (editor: Settings["editor"]) =>
      persist(() => store.updateEditor(editor)),
    formatting: {
      settings: preferences.formatting,
      update: (formatting: Settings["formatting"]) =>
        persist(() => store.updateFormatting(formatting)),
    },
    error: error ?? store.warning,
    ready,
    open,
    setOpen,
    closeGuard,
    openRequest,
    setCloseGuard,
    discard,
    apply,
    appearanceDirty: theme.dirty,
    section,
    setSection,
  };
}

const SettingsContext = createContext<ReturnType<
  typeof useSettingsState
> | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  return (
    <SettingsContext.Provider value={useSettingsState()}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const settings = useContext(SettingsContext);
  if (!settings) throw new Error("Missing settings provider");
  return settings;
}
