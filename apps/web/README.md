# Marketing site

TanStack Start + React marketing site for Texfolia, deployed to Cloudflare
Workers as `texfolia-web` (`texfolia.com` and `www.texfolia.com`). Local runs use
`texfolia-web-local`.

From the repository root, after [first-time setup](../../README.md#quick-start):

```sh
bun run dev:web
```

Open [localhost:4321](http://localhost:4321).

## Routes

| Route      | Rendering                 | Notes                                                       |
| ---------- | ------------------------- | ----------------------------------------------------------- |
| `/`        | Prerendered at build time | Landing page                                                |
| `/pricing` | Prerendered at build time | Plan names and prices come from `@texfolia/contracts/plans` |
| `/privacy` | Prerendered at build time | Placeholder policy for review (`noindex`)                   |
| `/terms`   | Prerendered at build time | Placeholder terms for review (`noindex`)                    |

The prerendered pages are served as static assets. Everything else, including
the not-found page, runs in the Worker.

## Product app links

Sign-in, **Open app**, and pricing CTAs link to `PUBLIC_APP_URL` (default
`http://localhost:3000` in development and `https://app.texfolia.com` in
production builds). Vite inlines it at build time, so set it before building.

The site does not use auth. Sign-in, OAuth callbacks, and session cookies stay on
`app.texfolia.com`.

## Project setup

The project follows the TanStack CLI scaffold (React, file router, Cloudflare
deployment): `.cta.json` records the choices, `tsr.config.json` configures route
generation, `components.json` points the shadcn CLI at `@texfolia/ui`, and
`tsconfig.json` extends `@texfolia/tsconfig/tanstack-start.json`. TanStack devtools load in
development only. Commit `src/routeTree.gen.ts` exactly as the generator writes it.

## Commands

Run with `bun run --cwd apps/web <command>`, or `dev:web` from the root.

```sh
bun run --cwd apps/web build      # Production build with prerendered pages
bun run --cwd apps/web preview    # Serve the build in local workerd
bun run --cwd apps/web test       # Unit tests
bun run --cwd apps/web typecheck
bun run --cwd apps/web generate-routes   # Rewrite src/routeTree.gen.ts (runs a build)
bun run --cwd apps/web cf:typegen        # Rewrite worker-configuration.d.ts
bun run --cwd apps/web deploy     # Deploy the last build as texfolia-web
```

From the repository root, `bun run deploy` builds first through Turbo.

Builds and previews run the Worker in local workerd through the Cloudflare
Vite plugin. Wrangler can't forward requests to workerd when Vite runs under
Bun's Node.js shim, so keep a real Node.js on `PATH` for `build` and `preview`.

Shared primitives (button, card, table) come from `@texfolia/ui`, imported only
through its public entry points. `src/styles.css` adds the package to Tailwind's
sources and defines the theme tokens these components read. Calls to action are
links styled by `linkButton` (`src/lib/link-button.ts`), which applies the shared
button variants at the site's larger sizes. Page layout, typography, and copy stay
here.
