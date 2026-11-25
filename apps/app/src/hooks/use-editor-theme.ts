import { useEffect, useMemo, useState } from "react";

import { editorTheme } from "#/lib/editor/themes/theme-editor";
import {
  loadedThemeExtension,
  loadThemeExtension,
} from "#/lib/editor/themes/theme-extensions";
import { useTheme } from "#/providers/theme-provider";

/** The shown theme as a CodeMirror extension, plain until its own one loads. */
export function useEditorTheme() {
  const { theme } = useTheme();
  const [, setLoaded] = useState(0);
  const extension = loadedThemeExtension(theme.id);
  useEffect(() => {
    if (extension) return;
    let live = true;
    loadThemeExtension(theme.id).then(
      () => {
        if (live) setLoaded((count) => count + 1);
      },
      // The theme provider reports themes that could not be loaded.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [theme.id, extension]);
  return useMemo(() => editorTheme(theme, extension ?? []), [theme, extension]);
}
