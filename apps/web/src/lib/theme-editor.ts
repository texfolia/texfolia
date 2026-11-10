import { createTheme } from "@uiw/codemirror-themes";
import { EditorView } from "@uiw/react-codemirror";

import type { resolveTheme } from "./themes";

export function editorTheme(theme: ReturnType<typeof resolveTheme>) {
  return [
    createTheme({
      theme: theme.mode,
      settings: theme.settings,
      styles: theme.styles,
    }),
    EditorView.theme(theme.editorStyles),
  ];
}
