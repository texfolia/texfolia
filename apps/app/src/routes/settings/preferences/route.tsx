import {
  createFileRoute,
  useBlocker,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import {
  SettingsCloseGuard,
  SettingsFooter,
  UserSettingsSections,
} from "#/components/settings-dialog";
import { useSettingsEditing } from "#/providers/settings-provider";
export const Route = createFileRoute("/settings/preferences")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { section?: "shortcuts" } => ({
    section: search.section === "shortcuts" ? "shortcuts" : undefined,
  }),
  component: PreferencesPage,
});
function PreferencesPage() {
  const settings = useSettingsEditing();
  const { section } = Route.useSearch();
  const navigate = useNavigate();
  const leaving = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !leaving.current && settings.dirty && current.routeId !== next.routeId,
    enableBeforeUnload: () => settings.dirty && !leaving.current,
    withResolver: true,
  });
  const { ready, begin, discard, setSection } = settings;
  useEffect(() => {
    if (ready) begin();
  }, [ready, begin]);
  useEffect(() => {
    if (section === "shortcuts") setSection("Keyboard shortcuts");
  }, [section, setSection]);
  useEffect(
    () => () => {
      discard();
    },
    [discard],
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
