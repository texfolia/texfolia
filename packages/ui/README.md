# @texfolia/ui

The shadcn (`base-nova`) React primitives used by the product app, built on
Base UI with Tabler icons. Import each component from its own entry point:

```ts
import { Button } from "@texfolia/ui/button";
import { Dialog, DialogContent } from "@texfolia/ui/dialog";
```

Components render Tailwind classes and read the app's theme tokens (`--primary`,
`--border`, `--sidebar`, and so on). A consuming app must define those tokens and
add the package to its Tailwind sources, as `apps/app/src/styles.css` does:

```css
@source "../../../packages/ui/src";
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
