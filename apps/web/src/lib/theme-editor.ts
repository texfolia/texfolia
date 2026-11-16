import { EditorView } from "@uiw/react-codemirror";

import type { resolveTheme } from "./themes";

export function editorTheme(theme: ReturnType<typeof resolveTheme>) {
  return [
    theme.extension,
    EditorView.theme({
      "&.cm-focused": { outline: "none" },
      ".cm-panels, .cm-tooltip": {
        backgroundColor: theme.variables["--popover"],
        color: theme.variables["--foreground"],
        borderColor: theme.variables["--border"],
      },
    }),
  ];
}
