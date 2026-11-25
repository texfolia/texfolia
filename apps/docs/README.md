# Documentation site

Astro + Starlight documentation site for Texfolia, built as static
assets for Cloudflare Workers (`texfolia-docs`; local runs use
`texfolia-docs-local`).

```sh
bun run --cwd apps/docs dev
```

Open [localhost:4322](http://localhost:4322).

## Content

Documentation pages live in `src/content/docs/` as Markdown or MDX files with
Starlight frontmatter.

## Commands

```sh
bun run --cwd apps/docs dev          # Start local dev server on port 4322
bun run --cwd apps/docs build        # Build static site to ./dist
bun run --cwd apps/docs preview      # Preview the built site on port 4322
bun run --cwd apps/docs typecheck    # Sync Astro types and run astro check
bun run --cwd apps/docs lint         # Run Oxlint
bun run --cwd apps/docs format:check # Check formatting with Oxfmt
bun run --cwd apps/docs deploy       # Deploy ./dist to Cloudflare Workers
```
