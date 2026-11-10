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
  appearanceSchema,
  appearanceStorageKey,
  bundledThemeIdSchema,
  defaultAppearance,
  parseTheme,
  resolveTheme,
  selectedTheme,
} from "#/lib/themes";

function readAppearance(userId: string): {
  appearance: Appearance;
  error: string | null;
} {
  try {
    const saved = localStorage.getItem(appearanceStorageKey(userId));
    if (saved)
      return {
        appearance: appearanceSchema.parse(JSON.parse(saved)),
        error: null,
      };
    // Migrate the old, independent editor theme only when no account preference exists.
    const legacy: unknown = JSON.parse(
      localStorage.getItem("texfolia.settings.v1") ?? "null",
    );
    const old = appearanceSchema.shape.selection.safeParse({
      kind: "bundled",
      id: findLegacyTheme(legacy),
    });
    return {
      appearance: old.success
        ? { ...defaultAppearance, selection: old.data }
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

function findLegacyTheme(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  for (const row of Object.values(value)) {
    if (typeof row !== "object" || row === null || !("data" in row)) continue;
    const data = row.data;
    if (typeof data !== "object" || data === null || !("editor" in data))
      continue;
    const editor = data.editor;
    if (typeof editor !== "object" || editor === null || !("theme" in editor))
      continue;
    const parsed = bundledThemeIdSchema.safeParse(editor.theme);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function useAppearance(userId: string) {
  const [initial] = useState(() => readAppearance(userId));
  const [appearance, setAppearance] = useState(initial.appearance);
  const [error, setError] = useState(initial.error);
  const [dark, setDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const theme = useMemo(
    () => resolveTheme(selectedTheme(appearance, dark)),
    [appearance.selection, dark],
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
    } catch {
      setError(
        "Your theme is applied, but could not be saved. Free browser storage and choose it again.",
      );
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

  function update(next: Appearance) {
    setAppearance(next);
    persist(next);
  }

  return {
    theme: { ...theme, extension },
    appearance,
    error,
    choose: (selection: Appearance["selection"]) =>
      update({ ...appearance, selection }),
    importTheme: (source: string) => {
      const theme = parseTheme(source);
      update({ ...appearance, selection: { kind: "imported", theme } });
    },
    setPdfMode: (pdfMode: Appearance["pdfMode"]) =>
      update({ ...appearance, pdfMode }),
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
