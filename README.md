# Texfolia

A browser-based LaTeX workspace. Edit project files, check LaTeX errors, and compile a PDF without leaving the editor.

[Website](https://www.texfolia.com) · [Quick start](#quick-start) · [System design](#system-design) · [Repository layout](#repository-layout)

> [!WARNING]
> Texfolia is pre-release. Features, APIs, and data formats may change without notice.

## Features

- LaTeX editing with syntax highlighting, folding, and completions for labels, citations, and file paths
- Spell check in each project's language, with a personal dictionary
- TexFmt formatting and a Problems panel for editor, project, and compiler diagnostics
- Side-by-side Markdown and PDF preview
- Workspace themes, settings, and programmable shortcuts
- Projects from a blank file, a template, or uploaded files and folders
- A template gallery, with publishing for your own projects

## Quick start

Requires [Bun](https://bun.sh) 1.4.4, [Docker](https://www.docker.com) with Compose, and the [Stripe CLI](https://docs.stripe.com/stripe-cli).

```sh
git clone https://github.com/natebabyak/texfolia.git
cd texfolia
bun install
cp apps/app/.env.example apps/app/.env
cp apps/web/.env.example apps/web/.env
cp packages/db/.env.example packages/db/.env
# Fill in the secrets in apps/app/.env, then:
bun run db:start
bun run db:push
bun run dev
```

Open the product app at [localhost:3000](http://localhost:3000), the marketing
site at [localhost:4321](http://localhost:4321), and the docs site at
[localhost:4322](http://localhost:4322). Create a project and press
Cmd/Ctrl+S to save and compile.

Secrets, Stripe webhooks, and running each app on its own are covered in the [local development guide](apps/docs/src/content/docs/local-development.md).

## System design

- **Browser:** a CodeMirror workspace, with workers for analysis, formatting, and spelling and an IndexedDB offline cache. The LaTeX language tooling, spelling, and editor themes live in `#/features/editor` (feature code is under `apps/app/src/features`); the shadcn primitives live in `@texfolia/ui`; R2 source objects (keys, uploads, limits, garbage collection) live in `#/features/storage`; the project aggregate (CRUD, file-tree nodes, paths, metadata, search, and owner/organization access) lives in `#/features/projects`; the app's compile client (source deltas, the `/api/compile` handlers, build events, logs, and history) lives in `#/features/compile`; Yjs collaboration (the room, protocol, browser cache, and drafts) lives in `#/features/collaboration`; Git integrations (actions against a linked GitHub or GitLab remote, remote URL parsing, and the platform adapters) live in `#/features/git`; Stripe billing (plans, checkout, the portal and webhooks, entitlements, and AI usage metering) lives in `#/features/billing`; the AI assistant (chat runs, project tools, saved threads, skills, and the panel UI) lives in `#/features/ai`.
- **Collaboration:** edits merge through Yjs in a Durable Object per project, then persist to R2.
- **Product app:** TanStack Start on Cloudflare Workers (`app.texfolia.com`). PostgreSQL holds accounts, the file tree, and build records.
- **Marketing site:** TanStack Start + React on Cloudflare Workers (`texfolia.com`). Static pages are prerendered; the templates gallery reads the app's public catalog API.
- **Compiler:** a Hono API. Each project gets its own LaTeX engine container, and the PDF streams back to the preview.

### Where editing and storage happen

```mermaid
flowchart TD
    subgraph Browser["Browser"]
        Editor["CodeMirror workspace"]
        Drafts[("IndexedDB offline cache")]
        Workers["Analysis and formatting workers"]
        Editor <-->|Offline Yjs updates| Drafts
        Editor <-->|Source, diagnostics, and edits| Workers
    end

    Editor <-->|Authenticated collaboration WebSocket| Collaboration["ProjectCollaboration Durable Object"]
    Collaboration <-->|Yjs snapshots and update journal| SQLite[("DO SQLite")]
    Collaboration -->|Persist merged text| R2[("Source R2 bucket")]
    Editor <-->|Projects, source saves, compile requests, and PDFs| App["TanStack Start product app"]
    App <-->|Read and write saved sources| R2
    App <-->|Accounts, file tree, source versions, and compile records| DB[("PostgreSQL")]
    App <-->|Optional social sign-in and billing| Services["OAuth providers and Stripe"]
    App <-->|Submit jobs, check status, and fetch PDFs| Compiler["Hono compiler API"]
```

### How a compile becomes a PDF

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as Product app
    participant P as Project coordinator
    participant T as Project container
    participant R as Artifact storage

    B->>W: Open project event stream
    W->>P: Attach after verifying project access
    P-->>B: Current revision and latest build metadata
    B->>W: Save sources, then request compile
    W->>P: Accept a revisioned source delta
    P->>P: Replace pending snapshot and debounce 300 ms
    P->>T: Cancel superseded run and wait for exit
    P->>T: Compile newest revision
    T-->>P: Stream PDF, then logs and artifacts
    P-->>W: Progressive PDF stream
    W-->>B: PDF bytes for the preview
    P->>R: Persist artifact generation
    P-->>B: Push saved build metadata
    B->>W: Fetch job status or saved PDF
```

More detail: [product app](apps/app/README.md), [marketing site](apps/web/README.md), [compiler](apps/compiler/README.md), and the [docs](apps/docs/README.md) app.

## Repository layout

```text
apps/
  app/                 React product app: auth, projects, and the compile endpoint
    src/features/      App features: ai, auth, billing, collaboration, comments,
                       compile, editor, email, git, projects, references, settings,
                       sharing, shortcuts, storage, templates, theme, workspace
  compiler/            Hono compiler API, job processing, and the LaTeX engine
  docs/                Astro + Starlight + React documentation site
  web/                 React marketing site: landing, pricing, policies, templates gallery
packages/
  contracts/           Schemas, hosts, and plan prices shared by the apps
  db/                  Drizzle schema, PostgreSQL client, and migrations
  ui/                  shadcn/Base UI React primitives for the app and the site
tsconfig.base.json     TypeScript settings every workspace extends
```

## Contributing

Texfolia is still in development and isn't accepting contributions yet.

## License

Texfolia is licensed under the [GNU General Public License v3.0](LICENSE).
