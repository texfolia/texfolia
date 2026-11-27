import { useNavigate } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";

import { createBrowserSettingsStore } from "#/lib/settings/settings.functions";
import {
  ShortcutsProvider,
  useAppShortcut,
} from "#/providers/shortcuts-provider";

export function NavigationShortcuts({ userId }: { userId: string }) {
  const [store] = useState(() => createBrowserSettingsStore(window, userId));
  const settings = useSyncExternalStore(store.subscribe, store.get, store.get);
  return (
    <ShortcutsProvider map={settings.shortcuts}>
      <NavigationActions />
    </ShortcutsProvider>
  );
}
function NavigationActions() {
  const navigate = useNavigate();
  useAppShortcut(
    "settings",
    () => void navigate({ to: "/settings/preferences" }),
  );
  useAppShortcut(
    "shortcuts",
    () =>
      void navigate({
        to: "/settings/preferences",
        search: { section: "shortcuts" },
      }),
  );
  return null;
}
