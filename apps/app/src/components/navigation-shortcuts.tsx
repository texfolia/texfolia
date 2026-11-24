import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { createBrowserSettingsStore } from "#/lib/settings/settings.functions";
import { defaultShortcuts } from "#/lib/shortcuts/shortcuts";
import {
  ShortcutsProvider,
  useAppShortcut,
} from "#/providers/shortcuts-provider";

export function NavigationShortcuts({ userId }: { userId: string }) {
  const [store] = useState(() => createBrowserSettingsStore(window, userId));
  const [ready, setReady] = useState(false);
  const { data } = useLiveQuery({
    query: (q) =>
      ready ? q.from({ preferences: store.preferences }) : undefined,
  });
  useEffect(() => {
    let active = true;
    void store
      .initialize()
      .then(() => {
        if (active) setReady(true);
      })
      .catch(() => {});
    return () => {
      active = false;
      void store.preferences.cleanup({ dependents: true });
    };
  }, [store]);
  return (
    <ShortcutsProvider map={data?.[0]?.shortcuts ?? defaultShortcuts}>
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
