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
  const [open, setOpen] = useState(false);
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
      { hotkey: "Mod+,", callback: () => setOpen((current) => !current) },
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
