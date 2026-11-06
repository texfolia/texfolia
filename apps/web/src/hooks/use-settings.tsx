import { useHotkeys } from "@tanstack/react-hotkeys";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { z } from "zod";

import { useLatexFormatSettings } from "#/components/latex-format-settings";
import { editorThemeSchema } from "#/lib/editor-themes";

const editorSettingsSchema = z.object({
  fontSize: z.number().int().min(10).max(24),
  wrapLines: z.boolean(),
  theme: editorThemeSchema.default("githubLight"),
});
type EditorSettings = z.infer<typeof editorSettingsSchema>;
const defaultEditorSettings: EditorSettings = {
  fontSize: 13,
  wrapLines: true,
  theme: "githubLight",
};
export type SettingsSection = "Editor" | "Formatting" | "Keyboard shortcuts";

function useSettingsState() {
  const [editor, setEditor] = useState(defaultEditorSettings);
  const formatting = useLatexFormatSettings();
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("Editor");

  useEffect(() => {
    try {
      const saved = editorSettingsSchema.safeParse(
        JSON.parse(localStorage.getItem("texfolia.editor") ?? "null"),
      );
      if (saved.success) setEditor(saved.data);
    } catch {
      // Browser storage may be unavailable; retain session preferences.
    }
  }, []);

  function updateEditor(next: EditorSettings) {
    setEditor(next);
    try {
      localStorage.setItem("texfolia.editor", JSON.stringify(next));
    } catch {
      // The preference still applies for the current session.
    }
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
    editor,
    updateEditor,
    formatting,
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
