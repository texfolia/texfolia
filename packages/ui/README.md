# @texfolia/ui

The shadcn (`base-nova`) React primitives shared by the product app and the
marketing site, built on Base UI with Tabler icons. Import each component from
its own entry point:

```ts
import { Button } from "@texfolia/ui/button";
import { Dialog, DialogContent } from "@texfolia/ui/dialog";
```

Components render Tailwind classes and read the consuming app's theme tokens
(`--primary`, `--border`, `--sidebar`, and so on). A consuming app must define the
tokens its components use and add the package to its Tailwind sources, as
`apps/app/src/styles.css` and `apps/web/src/styles.css` do:

```css
@source "../../../packages/ui/src";
```

`motion.css` holds the easing curves the components use (`ease-out`, `ease-in-out`,
`ease-drawer`) and the rules for reduced motion. Import it after Tailwind:

```css
@import "@texfolia/ui/motion.css";
```

The package has no app imports. App-specific behavior stays in the app: for
example, the sidebar keyboard shortcut is registered by the projects page, not
by `SidebarProvider`.

To add a shadcn component, run the shadcn CLI from this directory so
`components.json` writes into `src/`, then change imports of other primitives to
relative `./name.tsx` paths.

```sh
bun run --cwd packages/ui typecheck
```
