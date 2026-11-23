# @texfolia/templates

The template catalog and its snapshots: listing, publishing, previews, review,
cleanup, and creating a project from a template. A published snapshot is a
catalog entry, so catalog and publishing share one package.

| Entry point                  | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@texfolia/templates`        | Client-safe contracts: request schemas (`publishTemplateSchema`, `openTemplateSchema`, …), `templateLicenses` with labels and URLs, `templateSnapshotSchema`, and preview polling (`queuedTemplatePreviews`, `pollTemplatePreviews`)                                                                                                                                                                                                                                     |
| `@texfolia/templates/server` | Catalog: `listTemplates`, `listMyTemplates`, `findTemplate`, `getTemplate`, `templateArchive`, `templateDestinations`, `isTemplateReviewer`. Snapshots: `publishTemplate` and `openTemplate` (creates a project from a template). Previews: `refreshTemplatePreview` (one template, with the owner-or-reviewer retry check), `refreshTemplatePreviews` (the queue). Review: `reportTemplate`, `reviewTemplate`, `templateReviewQueue`. Cleanup: `collectTemplateObjects` |

Import only these entry points; `src/` paths are private.

See [Template lifecycle](../../docs/templates.md) for storage, moderation,
preview, and retention rules.

## Boundaries

The package depends on `@texfolia/db` (template rows), `@texfolia/storage` (R2
objects and ZIPs), `@texfolia/projects` (source paths and the `LockProject`
type), `@texfolia/compile` (source hashes and the compiler client for previews),
`@texfolia/auth` (organization roles), and `@texfolia/contracts`.

The caller passes in the rest:

- `lock`: `publishTemplate` takes a project lock built with `projectLock(grants)`,
  so the app decides which project access grants apply. After the lock,
  publishing itself requires the project owner or an organization admin.
- `bucket`: the `SOURCES` R2 binding.
- `reviewers`: the comma-separated `TEMPLATE_REVIEWER_IDS` variable.

Server-function wrappers and sessions (`apps/app/src/lib/template.functions.ts`),
the React binding for preview polling, the `/template`, `/templates`, and
`/api/templates` routes, scheduled handlers, and the create-from-template UI stay
in `apps/app`. The public gallery stays in `apps/web`, which reads
`GET /api/templates`. Curated starters and their seed CLI stay in `@texfolia/db`.

## Checks

```sh
bun run --cwd packages/templates test
bun run --cwd packages/templates typecheck
```

Database and R2 behavior is covered by `apps/app/test/templates.ts`, which needs
`INTEGRATION_DATABASE_URL`.
