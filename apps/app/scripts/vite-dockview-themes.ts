import postcss from "postcss";
import type { Plugin } from "vite";

const themeClass = /\.dockview-theme-/;

/** Dockview's stylesheet without the themes it bundles. */
export function withoutThemes(css: string) {
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (rule.selectors.every((selector) => themeClass.test(selector)))
      rule.remove();
  });
  return root.toString();
}

/**
 * The app styles Dockview with its own `dockview-theme-texfolia`, and the
 * bundled themes are two thirds of the stylesheet.
 */
export function dockviewThemes(): Plugin {
  return {
    name: "dockview-without-themes",
    enforce: "pre",
    transform: {
      filter: { id: /[\\/]dockview-[a-z]+[\\/].*[\\/]dockview\.css(?:$|\?)/ },
      handler: (code) => ({ code: withoutThemes(code), map: null }),
    },
  };
}
