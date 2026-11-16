import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useMemo,
  useState,
} from "react";

import { type FormatSettings } from "#/lib/latex/format";
import { updateProjectFormatting } from "#/lib/project.functions";
import { rebaseUserDraft, rebaseFormattingDraft } from "#/lib/settings-draft";
import { createBrowserSettingsStore } from "#/lib/settings.functions";
import {
  defaultSettings,
  settingsSchema,
  type Settings,
} from "#/lib/settings.schema";
import { shortcutConflicts } from "#/lib/shortcuts";
import {
  ShortcutsProvider,
  useAppShortcut,
} from "#/providers/shortcuts-provider";
import { useTheme } from "#/providers/theme-provider";
export type SettingsSection = "Appearance" | "Editor" | "Keyboard shortcuts";
type SettingsProject = {
  id: string;
  canWrite: boolean;
  formatting: FormatSettings;
};

function useSettingsState(userId: string, project?: SettingsProject) {
  const [store] = useState(() => createBrowserSettingsStore(window, userId));
  const [ready, setReady] = useState(false);
  const [userReady, setUserReady] = useState(false);
  const [userLoadError, setUserLoadError] = useState<string | null>(null);
  const { data } = useLiveQuery({
    query: (q) =>
      userReady ? q.from({ preferences: store.preferences }) : undefined,
  });
  const preferences = useMemo(
    () => settingsSchema.parse(data?.[0] ?? defaultSettings),
    [data?.[0]],
  );
  const previousUser = useRef(preferences);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [committedFormatting, setCommittedFormatting] = useState(
    project?.formatting,
  );
  const [draftFormatting, setDraftFormatting] = useState(project?.formatting);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpenState] = useState(false);
  const [closeGuard, setCloseGuard] = useState(false);
  const [section, setSection] = useState<SettingsSection>("Appearance");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const theme = useTheme();
  const userDirty =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(preferences);
  const projectDirty =
    JSON.stringify(draftFormatting) !== JSON.stringify(committedFormatting);
  const dirty = userDirty || projectDirty || theme.dirty;
  function begin() {
    if (open) return;
    setDraft(preferences);
    setDraftFormatting(committedFormatting);
    theme.beginDraft();
    setError(null);
    setOpenState(true);
  }
  function discard() {
    if (inFlight.current) return;
    theme.discardDraft();
    setDraft(null);
    setDraftFormatting(committedFormatting);
    setCloseGuard(false);
    setOpenState(false);
  }
  function setOpen(next: boolean) {
    if (inFlight.current) return;
    if (next) begin();
    else if (dirty) setCloseGuard(true);
    else discard();
  }
  async function apply(close = false) {
    if (!ready || inFlight.current) return false;
    if (draft && shortcutConflicts(draft.shortcuts).length) {
      setError("Resolve shortcut conflicts before applying settings.");
      return false;
    }
    inFlight.current = true;
    setSaving(true);
    setError(null);
    const failures: string[] = [];
    try {
      if (projectDirty && project && draftFormatting) {
        if (!project.canWrite)
          failures.push(
            "Project formatting: you have view access. Ask a project editor to save these changes.",
          );
        else {
          try {
            const next = await updateProjectFormatting({
              data: { projectId: project.id, formatting: draftFormatting },
            });
            setCommittedFormatting(next);
          } catch (cause) {
            failures.push(
              `Project formatting: ${cause instanceof Error ? cause.message : "could not be saved. Try Apply again."}`,
            );
          }
        }
      }
      if (userDirty && draft) {
        try {
          if (!userReady)
            throw new Error(
              "Browser preferences could not be loaded. Reload to try again.",
            );
          await store.save(draft);
        } catch (cause) {
          failures.push(
            `User preferences: ${cause instanceof Error ? cause.message : "could not be saved. Try Apply again."}`,
          );
        }
      }
      if (theme.dirty && !theme.commitDraft())
        failures.push(
          "Appearance could not be saved. Free browser storage and try Apply again.",
        );
      if (failures.length) {
        setError(failures.join(" "));
        return false;
      }
      setCloseGuard(false);
      if (close) {
        theme.discardDraft();
        setDraft(null);
        setOpenState(false);
      }
      return true;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  useEffect(() => {
    const previous = previousUser.current;
    previousUser.current = preferences;
    setDraft((current) =>
      current ? rebaseUserDraft(current, previous, preferences) : null,
    );
  }, [preferences]);
  useEffect(() => {
    const next = project?.formatting;
    if (!next) return;
    setDraftFormatting((current) =>
      current && committedFormatting
        ? rebaseFormattingDraft(current, committedFormatting, next)
        : next,
    );
    setCommittedFormatting(next);
  }, [
    project?.id,
    project?.formatting.indent,
    project?.formatting.wrap,
    project?.formatting.width,
  ]);

  useEffect(() => {
    let active = true;
    void store
      .initialize()
      .then(() => {
        if (active) {
          setReady(true);
          setUserReady(true);
        }
      })
      .catch(() => {
        if (active) {
          setReady(true);
          setUserLoadError(
            "Browser preferences could not be loaded. Editor and shortcut controls are unavailable; reload to try again. Appearance and project settings are still available.",
          );
        }
      });
    return () => {
      active = false;
      void store.preferences.cleanup({ dependents: true });
    };
  }, [store]);
  async function updateEditor(editor: Settings["editor"]) {
    if (!userReady) {
      setError("Browser preferences could not be loaded. Reload to try again.");
      return;
    }
    setError(null);
    try {
      await store.updateEditor(editor);
    } catch {
      setError(
        "Your preference could not be saved. Check browser storage and try again.",
      );
    }
  }
  return {
    editor: preferences.editor,
    shortcuts: preferences.shortcuts,
    updateEditor,
    draft: draft ?? preferences,
    setDraft,
    project,
    formatting: committedFormatting,
    draftFormatting,
    setDraftFormatting: (next: FormatSettings) => {
      if (project?.canWrite) setDraftFormatting(next);
    },
    dirty,
    error: error ?? userLoadError ?? store.warning,
    ready,
    userReady,
    open,
    setOpen,
    begin,
    closeGuard,
    setCloseGuard,
    discard,
    apply,
    saving,
    section,
    setSection,
  };
}
const SettingsContext = createContext<ReturnType<
  typeof useSettingsState
> | null>(null);
export function SettingsProvider({
  userId,
  project,
  children,
}: {
  userId: string;
  project?: SettingsProject;
  children: ReactNode;
}) {
  const value = useSettingsState(userId, project);
  return (
    <SettingsContext value={value}>
      <ShortcutsProvider map={value.shortcuts}>
        <SettingsShortcuts />
        {children}
      </ShortcutsProvider>
    </SettingsContext>
  );
}
function SettingsShortcuts() {
  const settings = useSettings();
  const navigate = useNavigate();
  const open = (shortcuts: boolean) => {
    settings.setSection(shortcuts ? "Keyboard shortcuts" : "Appearance");
    if (settings.project) settings.setOpen(true);
    else
      void navigate({
        to: "/settings/preferences",
        search: { section: shortcuts ? "shortcuts" : undefined },
      });
  };
  useAppShortcut("settings", () => open(false));
  useAppShortcut("shortcuts", () => open(true));
  return null;
}
export function useSettings() {
  const settings = useContext(SettingsContext);
  if (!settings) throw new Error("Missing settings provider");
  return settings;
}
