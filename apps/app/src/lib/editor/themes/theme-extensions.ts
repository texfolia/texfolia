import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import type { Extension } from "@uiw/react-codemirror";

import { themeLoaders } from "./theme-loaders.gen";
import type { ThemeId } from "./themes";

// Themes load from their own packages, except the GitHub pair used by "system".
const loadedExtensions = new Map<ThemeId, Extension>([
  ["githubLight", githubLight],
  ["githubDark", githubDark],
]);
const pendingExtensions = new Map<ThemeId, Promise<Extension>>();

/** The theme's CodeMirror extension if it has loaded, otherwise undefined. */
export function loadedThemeExtension(id: ThemeId) {
  return loadedExtensions.get(id);
}

export function loadThemeExtension(id: ThemeId): Promise<Extension> {
  const loaded = loadedExtensions.get(id);
  if (loaded) return Promise.resolve(loaded);
  let pending = pendingExtensions.get(id);
  if (!pending) {
    pending = themeLoaders[id]().then(
      (extension) => {
        loadedExtensions.set(id, extension);
        pendingExtensions.delete(id);
        return extension;
      },
      (error: unknown) => {
        // Allow a retry after a failed chunk request.
        pendingExtensions.delete(id);
        throw error;
      },
    );
    pendingExtensions.set(id, pending);
  }
  return pending;
}

/** Lets the app's colors wait for the matching editor theme. */
export const editorThemes = {
  loaded: (id: ThemeId) => loadedExtensions.has(id),
  load: loadThemeExtension,
};
