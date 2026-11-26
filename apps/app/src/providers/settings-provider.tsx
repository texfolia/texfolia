import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate } from "@tanstack/react-router";
import { type FormatSettings } from "@texfolia/editor";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useMemo,
  useState,
} from "react";

import { useStableActions } from "#/hooks/use-stable-callback";
import type { SpellingLanguage } from "#/lib/editor/spelling/languages";
import {
  updateProjectFormatting,
  updateProjectSpelling,
} from "#/lib/projects/project.functions";
import {
  rebaseUserDraft,
  rebaseFormattingDraft,
} from "#/lib/settings/settings-draft";
import { createBrowserSettingsStore } from "#/lib/settings/settings.functions";
import {
  defaultSettings,
  settingsSchema,
  type Settings,
} from "#/lib/settings/settings.schema";
import { shortcutConflicts } from "#/lib/shortcuts/shortcuts";
import {
  ShortcutsProvider,
  useAppShortcut,
} from "#/providers/shortcuts-provider";
import { useTheme } from "#/providers/theme-provider";
export type SettingsSection =
  | "Appearance"
  | "Editor"
  | "Spelling"
  | "Keyboard shortcuts";
type SettingsProject = {
  id: string;
  canWrite: boolean;
  formatting: FormatSettings;
  spelling: SpellingLanguage;
  /** Saves the main document; null is the default. */
  setMainFile: (mainFile: string | null) => Promise<void>;
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
  const saved = data?.[0];
  const preferences = useMemo(
    () => settingsSchema.parse(saved ?? defaultSettings),
    [saved],
  );
  const previousUser = useRef(preferences);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [committedFormatting, setCommittedFormatting] = useState(
    project?.formatting,
  );
  const [draftFormatting, setDraftFormatting] = useState(project?.formatting);
  const [committedSpelling, setCommittedSpelling] = useState(project?.spelling);
  const [draftSpelling, setDraftSpelling] = useState(project?.spelling);
  // Undefined until it is changed. The file tree also sets the main document, so
  // the file store holds the saved one.
  const [draftMainFile, setDraftMainFile] = useState<string | null>();
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
  const spellingDirty = draftSpelling !== committedSpelling;
  const mainFileDirty = draftMainFile !== undefined;
  const dirty =
    userDirty || projectDirty || spellingDirty || mainFileDirty || theme.dirty;
  function begin() {
    if (open) return;
    setDraft(preferences);
    setDraftFormatting(committedFormatting);
    setDraftSpelling(committedSpelling);
    setDraftMainFile(undefined);
    theme.beginDraft();
    setError(null);
    setOpenState(true);
  }
  function discard() {
    if (inFlight.current) return;
    theme.discardDraft();
    setDraft(null);
    setDraftFormatting(committedFormatting);
    setDraftSpelling(committedSpelling);
    setDraftMainFile(undefined);
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
      if (spellingDirty && project && draftSpelling) {
        if (!project.canWrite)
          failures.push(
            "Project spelling: you have view access. Ask a project editor to save these changes.",
          );
        else {
          try {
            const next = await updateProjectSpelling({
              data: { projectId: project.id, language: draftSpelling },
            });
            setCommittedSpelling(next);
          } catch (cause) {
            failures.push(
              `Project spelling: ${cause instanceof Error ? cause.message : "could not be saved. Try Apply again."}`,
            );
          }
        }
      }
      if (mainFileDirty && project) {
        if (!project.canWrite)
          failures.push(
            "Main document: you have view access. Ask a project editor to save these changes.",
          );
        else {
          try {
            await project.setMainFile(draftMainFile);
            setDraftMainFile(undefined);
          } catch (cause) {
            failures.push(
              `Main document: ${cause instanceof Error ? cause.message : "could not be saved. Try Apply again."}`,
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
  const rebaseFormatting = useEffectEvent(() => {
    const next = project?.formatting;
    if (!next) return;
    setDraftFormatting((current) =>
      current && committedFormatting
        ? rebaseFormattingDraft(current, committedFormatting, next)
        : next,
    );
    setCommittedFormatting(next);
  });
  useEffect(
    () => rebaseFormatting(),
    [
      project?.id,
      project?.formatting.indent,
      project?.formatting.wrap,
      project?.formatting.width,
    ],
  );
  const rebaseSpelling = useEffectEvent(() => {
    const next = project?.spelling;
    if (!next) return;
    setDraftSpelling((current) =>
      current && current !== committedSpelling ? current : next,
    );
    setCommittedSpelling(next);
  });
  useEffect(() => rebaseSpelling(), [project?.id, project?.spelling]);

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
  async function addWord(word: string) {
    if (!userReady) {
      setError("Browser preferences could not be loaded. Reload to try again.");
      return;
    }
    setError(null);
    try {
      await store.addWord(word);
    } catch {
      setError(
        "The word could not be added to your dictionary. Check browser storage and try again.",
      );
    }
  }
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
  const actions = useStableActions({
    addWord,
    updateEditor,
    setOpen,
    begin,
    discard,
    apply,
    setDraftFormatting: (next: FormatSettings) => {
      if (project?.canWrite) setDraftFormatting(next);
    },
    setDraftSpelling: (next: SpellingLanguage) => {
      if (project?.canWrite) setDraftSpelling(next);
    },
    setDraftMainFile: (next: string | null | undefined) => {
      if (project?.canWrite) setDraftMainFile(next);
    },
  });
  const applied = useMemo(
    () => ({
      editor: preferences.editor,
      compile: preferences.compile,
      shortcuts: preferences.shortcuts,
      spelling: preferences.spelling,
      formatting: committedFormatting,
      spellingLanguage: committedSpelling,
      open,
      setOpen: actions.setOpen,
      addWord: actions.addWord,
      updateEditor: actions.updateEditor,
    }),
    [preferences, committedFormatting, committedSpelling, open, actions],
  );
  const shownError = error ?? userLoadError ?? store.warning;
  const editing = useMemo(
    () => ({
      draft: draft ?? preferences,
      setDraft,
      project,
      draftFormatting,
      draftSpelling,
      draftMainFile,
      dirty,
      error: shownError,
      ready,
      userReady,
      open,
      closeGuard,
      setCloseGuard,
      saving,
      section,
      setSection,
      setOpen: actions.setOpen,
      begin: actions.begin,
      discard: actions.discard,
      apply: actions.apply,
      setDraftFormatting: actions.setDraftFormatting,
      setDraftSpelling: actions.setDraftSpelling,
      setDraftMainFile: actions.setDraftMainFile,
    }),
    [
      draft,
      preferences,
      project,
      draftFormatting,
      draftSpelling,
      draftMainFile,
      dirty,
      shownError,
      ready,
      userReady,
      open,
      closeGuard,
      saving,
      section,
      actions,
    ],
  );
  return { applied, editing };
}
type SettingsState = ReturnType<typeof useSettingsState>;
const AppliedSettingsContext = createContext<SettingsState["applied"] | null>(
  null,
);
const SettingsEditingContext = createContext<SettingsState["editing"] | null>(
  null,
);
export function SettingsProvider({
  userId,
  project,
  children,
}: {
  userId: string;
  project?: SettingsProject;
  children: ReactNode;
}) {
  const { applied, editing } = useSettingsState(userId, project);
  return (
    <AppliedSettingsContext value={applied}>
      <SettingsEditingContext value={editing}>
        <ShortcutsProvider
          map={applied.shortcuts}
          editorKeymap={applied.editor.keymap}
        >
          <SettingsShortcuts />
          {children}
        </ShortcutsProvider>
      </SettingsEditingContext>
    </AppliedSettingsContext>
  );
}
function SettingsShortcuts() {
  const settings = useSettingsEditing();
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
/** The settings in effect. These change only when a change is applied. */
export function useSettings() {
  const settings = useContext(AppliedSettingsContext);
  if (!settings) throw new Error("Missing settings provider");
  return settings;
}
/** The settings dialog and its draft, which changes with every edit in it. */
export function useSettingsEditing() {
  const settings = useContext(SettingsEditingContext);
  if (!settings) throw new Error("Missing settings provider");
  return settings;
}
