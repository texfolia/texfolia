import type { Plugin } from "vite";

const transform: Plugin = {
  name: "emacs-keymap-bindings",
  transform: {
    filter: { id: /[\\/]@replit[\\/]codemirror-emacs[\\/]/ },
    handler: (code) => ({
      code: code.replaceAll("/*@__PURE__*/EmacsHandler.", "EmacsHandler."),
      map: null,
    }),
  },
};

/**
 * `@replit/codemirror-emacs` marks its key registration `@__PURE__`, so both
 * the production build and dev prebundling drop every binding. This removes
 * those annotations in both places.
 */
export function emacsKeymap(): Plugin {
  return {
    ...transform,
    config: () => ({
      optimizeDeps: { rolldownOptions: { plugins: [transform] } },
    }),
  };
}
