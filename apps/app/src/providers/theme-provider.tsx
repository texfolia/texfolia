import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import { useStableActions } from "#/hooks/use-stable-callback";
import {
  type Appearance,
  defaultAppearance,
  migrateAppearance,
  selectedTheme,
} from "#/lib/editor/themes/appearance";
import {
  appearanceStorageKey,
  legacyAppearanceStorageKey,
  resolveTheme,
  type ThemeId,
} from "#/lib/editor/themes/themes";
import { appearanceSnapshot } from "#/lib/theme/theme-bootstrap";

function readAppearance(userId: string): {
  appearance: Appearance;
  error: string | null;
} {
  try {
    const saved =
      localStorage.getItem(appearanceStorageKey(userId)) ??
      localStorage.getItem(legacyAppearanceStorageKey(userId));
    return {
      appearance: saved
        ? migrateAppearance(JSON.parse(saved))
        : defaultAppearance,
      error: null,
    };
  } catch {
    return {
      appearance: defaultAppearance,
      error:
        "Saved appearance could not be loaded. Choose a theme to save it again.",
    };
  }
}

/** The CodeMirror themes of a page with editors, such as the workspace. */
export type EditorThemes = {
  loaded: (id: ThemeId) => boolean;
  load: (id: ThemeId) => Promise<unknown>;
};

function useAppearance(userId: string, editorThemes?: EditorThemes) {
  const [initial] = useState(() => readAppearance(userId));
  const [appearance, setAppearance] = useState(initial.appearance);
  const [draft, setDraft] = useState<Appearance | null>(null);
  const [preview, setPreview] = useState<Appearance["selection"] | null>(null);
  const displayed = draft ?? appearance;
  const effective = preview ? { ...displayed, selection: preview } : displayed;
  const [error, setError] = useState(initial.error);
  const [dark, setDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const requested = useMemo(
    () => selectedTheme(effective, dark),
    [effective.selection, dark],
  );
  const loaded = !editorThemes || editorThemes.loaded(requested.id);
  // On a page with editors, a newly requested theme is shown only once its
  // editor theme arrives, so app colors and the editor switch together. The
  // first theme is shown at once to match the bootstrap colors.
  const [ready, setReady] = useState(requested);
  const [, setLoaded] = useState(0);
  const shown = loaded ? requested : ready;
  useEffect(() => {
    if (loaded) {
      setReady(requested);
      return;
    }
    let live = true;
    editorThemes.load(requested.id).then(
      () => {
        if (live) setLoaded((count) => count + 1);
      },
      () => {
        if (live)
          setError(
            `${requested.name} could not be loaded. Check your connection and choose it again.`,
          );
      },
    );
    return () => {
      live = false;
    };
  }, [requested, loaded, editorThemes]);
  const theme = useMemo(() => resolveTheme(shown), [shown]);

  function persist(
    next: Appearance,
    resolved = resolveTheme(selectedTheme(next, dark)),
  ) {
    try {
      localStorage.setItem(
        appearanceStorageKey(userId),
        JSON.stringify({ ...next, preview: appearanceSnapshot(resolved) }),
      );
      setError(null);
      return true;
    } catch {
      setError(
        "Appearance could not be saved. Free browser storage and try Apply again.",
      );
      return false;
    }
  }

  useEffect(() => {
    if (!initial.error) persist(initial.appearance);
  }, []);

  useLayoutEffect(() => {
    // Authenticated pages are client rendered. Apply before their first paint,
    // including body portals, and restore the brand before leaving the app.
    const root = document.documentElement;
    root.classList.toggle("dark", theme.mode === "dark");
    root.style.colorScheme = theme.mode;
    root.dataset.appTheme = theme.name;
    for (const [key, value] of Object.entries(theme.variables))
      root.style.setProperty(key, value);
    return () => {
      for (const key of Object.keys(theme.variables))
        root.style.removeProperty(key);
      root.classList.remove("dark");
      root.style.removeProperty("color-scheme");
      delete root.dataset.appTheme;
    };
  }, [theme]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setDark(media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === appearanceStorageKey(userId) || event.key === null) {
        const next = readAppearance(userId);
        setAppearance(next.appearance);
        setError(next.error);
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [userId]);

  function commitDraft() {
    const next = draft ?? appearance;
    if (!persist(next)) return false;
    setAppearance(next);
    setDraft(next);
    setPreview(null);
    return true;
  }

  const actions = useStableActions({
    beginDraft: () => {
      setDraft(appearance);
      setPreview(null);
    },
    discardDraft: () => {
      setDraft(null);
      setPreview(null);
    },
    commitDraft,
    choose: (selection: Appearance["selection"]) => {
      setDraft({ ...displayed, selection });
    },
    setDraftPdfMode: (pdfMode: Appearance["pdfMode"]) =>
      setDraft({ ...displayed, pdfMode }),
    setPdfMode: (pdfMode: Appearance["pdfMode"]) => {
      const next = { ...appearance, pdfMode };
      if (persist(next)) {
        setAppearance(next);
        setDraft((current) => (current ? { ...current, pdfMode } : null));
      }
    },
  });
  const dirty = useMemo(
    () =>
      draft !== null && JSON.stringify(draft) !== JSON.stringify(appearance),
    [draft, appearance],
  );
  return useMemo(
    () => ({
      theme,
      appearance: displayed,
      error,
      dirty,
      preview: setPreview,
      ...actions,
    }),
    [theme, displayed, error, dirty, actions],
  );
}

const ThemeContext = createContext<ReturnType<typeof useAppearance> | null>(
  null,
);

type ThemeProviderProps = {
  userId: string;
  editorThemes?: EditorThemes;
  children: ReactNode;
};

export function ThemeProvider(props: ThemeProviderProps) {
  return <AccountTheme key={props.userId} {...props} />;
}

function AccountTheme({ userId, editorThemes, children }: ThemeProviderProps) {
  const value = useAppearance(userId, editorThemes);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("Missing app theme provider");
  return theme;
}
