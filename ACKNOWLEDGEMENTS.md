# Acknowledgements

Texfolia is built on the work of many open-source projects. Thank you to their
authors and maintainers. This list covers the main ones; each package's own
license is in `node_modules`, the Go module cache, or the engine image.

## LaTeX

- [Tectonic](https://tectonic-typesetting.github.io): the TeX engine that builds
  every PDF (MIT).
- [Biber](https://github.com/plk/biber) and [biblatex](https://github.com/plk/biblatex):
  bibliographies (Artistic License 2.0, LPPL).
- The [TeX Live](https://tug.org/texlive/) and [CTAN](https://ctan.org)
  communities, whose packages the engine bundle carries.
- [tex-fmt](https://github.com/WGUNDERWOOD/tex-fmt): LaTeX source formatter
  (MIT), compiled to WebAssembly in `@texfolia/tex-fmt`.

## Editor and workspace

- [CodeMirror](https://codemirror.net) and
  [@uiw/react-codemirror](https://github.com/uiwjs/react-codemirror) (MIT).
- [Yjs](https://yjs.dev), `y-protocols` and `y-indexeddb`: real-time
  collaboration and the offline cache (MIT).
- [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) and
  [react-pdf](https://github.com/wojtekmaj/react-pdf) (MIT): the PDF preview.
- [Dockview](https://dockview.dev): the panel layout (MIT).
- [nspell](https://github.com/wooorm/nspell) and the
  [dictionary](https://github.com/wooorm/dictionaries) packages: spell check
  (MIT, plus each dictionary's own license).
- [isomorphic-git](https://isomorphic-git.org): Git in the Worker (MIT).

## Platform

- [TanStack Start and Router](https://tanstack.com) (MIT) and
  [React](https://react.dev) (MIT).
- [Base UI](https://base-ui.com), [shadcn/ui](https://ui.shadcn.com),
  [Tailwind CSS](https://tailwindcss.com) and
  [Tabler Icons](https://tabler.io/icons) (MIT).
- [Cloudflare Workers](https://workers.cloudflare.com), Wrangler and workerd
  (MIT, Apache-2.0).
- [Better Auth](https://better-auth.com): accounts, organizations and Stripe
  billing (MIT).
- [Drizzle ORM](https://orm.drizzle.team) (Apache-2.0) and
  [node-postgres](https://node-postgres.com) (MIT), on
  [PostgreSQL](https://www.postgresql.org).
- [Hono](https://hono.dev) and [Zod](https://zod.dev) (MIT).
- [Next.js](https://nextjs.org) and [Fumadocs](https://fumadocs.dev):
  the documentation site (MIT).

## Tooling

[Bun](https://bun.sh), [Turborepo](https://turborepo.com),
[TypeScript](https://www.typescriptlang.org), [Vite](https://vite.dev),
[Oxc](https://oxc.rs) (oxlint and oxfmt), [Playwright](https://playwright.dev)
and [Go](https://go.dev).

The local development setup takes its shape from
[Supabase's monorepo guide](https://github.com/supabase/supabase/blob/master/DEVELOPERS.md).
