import {
  createFileRoute,
  useBlocker,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { z } from "zod";

import {
  SettingsCloseGuard,
  SettingsFooter,
  UserSettingsSections,
} from "#/components/settings-dialog";
import { useSettings } from "#/providers/settings-provider";
export const Route = createFileRoute("/settings/preferences")({
  validateSearch: z.object({ section: z.literal("shortcuts").optional() }),
  component: PreferencesPage,
});
function PreferencesPage() {
  const settings = useSettings();
  const { section } = Route.useSearch();
  const navigate = useNavigate();
  const leaving = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !leaving.current && settings.dirty && current.routeId !== next.routeId,
    enableBeforeUnload: () => settings.dirty && !leaving.current,
    withResolver: true,
  });
  useEffect(() => {
    if (settings.ready) settings.begin();
  }, [settings.ready]);
  useEffect(() => {
    if (section === "shortcuts") settings.setSection("Keyboard shortcuts");
  }, [section]);
  useEffect(
    () => () => {
      settings.discard();
    },
    [],
  );
  const exit = () => {
    leaving.current = true;
    void navigate({ to: "/projects" });
  };
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Preferences</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Make Texfolia yours. These preferences are saved for your account in
          this browser.
        </p>
      </div>
      <fieldset disabled={!settings.ready || settings.saving}>
        <UserSettingsSections />
      </fieldset>
      <SettingsFooter onSave={exit} onCancel={exit} />
      <SettingsCloseGuard
        open={blocker.status === "blocked"}
        onKeepEditing={() => blocker.reset?.()}
        onApply={() => blocker.reset?.()}
        onDiscard={() => {
          leaving.current = true;
          blocker.proceed?.();
        }}
      />
    </div>
  );
}
