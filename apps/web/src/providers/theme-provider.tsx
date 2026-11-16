import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import { appearanceSnapshot } from "#/lib/theme-bootstrap";
import { editorTheme } from "#/lib/theme-editor";
import {
  type Appearance,
  appearanceStorageKey,
  defaultAppearance,
  legacyAppearanceStorageKey,
  migrateAppearance,
  resolveTheme,
  selectedTheme,
} from "#/lib/themes";

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

function useAppearance(userId: string) {
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
  const theme = useMemo(
    () => resolveTheme(selectedTheme(effective, dark)),
    [effective.selection, dark],
  );

  const extension = useMemo(() => editorTheme(theme), [theme]);

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

  return {
    theme: { ...theme, extension },
    appearance: displayed,
    error,
    dirty:
      draft !== null && JSON.stringify(draft) !== JSON.stringify(appearance),
    beginDraft: () => {
      setDraft(appearance);
      setPreview(null);
    },
    discardDraft: () => {
      setDraft(null);
      setPreview(null);
    },
    commitDraft,
    preview: setPreview,
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
  };
}

const ThemeContext = createContext<ReturnType<typeof useAppearance> | null>(
  null,
);

export function ThemeProvider({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  return (
    <AccountTheme key={userId} userId={userId}>
      {children}
    </AccountTheme>
  );
}

function AccountTheme({
  userId,
  children,
}: {
  userId: string;
  children: ReactNode;
}) {
  const value = useAppearance(userId);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("Missing app theme provider");
  return theme;
}
