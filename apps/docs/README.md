# Documentation site

Fumadocs + Next.js documentation site for Texfolia, exported statically to
`./out` and deployed as Cloudflare Workers static assets (`texfolia-docs`; local
runs use `texfolia-docs-local`).

From the repository root:

```sh
bun run dev:docs
```

Open [localhost:4322](http://localhost:4322).

## Content

Documentation pages live in `content/docs/` as Markdown or MDX files with
Fumadocs frontmatter (`title` and optional `description`). Sidebar sections and
order are configured in `content/docs/meta.json` and folder `meta.json` files.

The site exports:

- Client-side static search backed by `/api/search` (generated at build time)
- `/llms.txt`, `/llms-full.txt`, and per-page processed Markdown under `/llms.mdx/*.md`
- Root-level trailing-slash URLs (for example `/local-development/`); Wrangler's
  static asset handler redirects non-trailing-slash paths automatically

## Commands

```sh
bun run --cwd apps/docs dev          # Start local Next.js dev server on port 4322
bun run --cwd apps/docs build        # Export static site to ./out
bun run --cwd apps/docs preview      # Serve ./out locally via Wrangler on port 4322
bun run --cwd apps/docs test         # Run production-like smoke check against ./out
bun run --cwd apps/docs typecheck    # Generate Fumadocs/Next types and run tsc
bun run --cwd apps/docs lint         # Run Oxlint
bun run --cwd apps/docs format:check # Check formatting with Oxfmt
bun run --cwd apps/docs deploy       # Deploy ./out to Cloudflare Workers (texfolia-docs)
```
